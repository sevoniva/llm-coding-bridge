"use strict";

const {
  getApiKey,
  upstreamUrl,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_SSE_EVENT_BYTES,
} = require("./config");
const { parseNonStreamChatResponse } = require("./chat-compat");
const { writeWithBackpressure } = require("./http-util");
const { createPhaseDeadline } = require("./phase-timeout");

const bodyContexts = new WeakMap();

function positiveInteger(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

function upstreamError(message, code, name = "Error") {
  const error = new Error(message);
  error.code = code;
  error.name = name;
  return error;
}

function abortError() {
  return upstreamError("Upstream request aborted.", "UPSTREAM_ABORTED", "AbortError");
}

function responseLimitError() {
  return upstreamError("Upstream response exceeded the configured limit.", "UPSTREAM_RESPONSE_TOO_LARGE");
}

function eventLimitError() {
  return upstreamError("Upstream SSE event exceeded the configured limit.", "UPSTREAM_SSE_EVENT_TOO_LARGE");
}

function phasePolicy(upstream, timeoutMs) {
  const reliability = upstream.reliability || {};
  const timeout = (name, fallback, allowZero = false) => {
    const value = reliability[name] === undefined ? fallback : Number(reliability[name]);
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new Error(`upstream.reliability.${name} must be ${allowZero ? "a non-negative" : "a positive"} integer.`);
    }
    return value;
  };
  return {
    headerTimeoutMs: timeout("headerTimeoutMs", timeoutMs),
    firstDataTimeoutMs: timeout("firstDataTimeoutMs", timeoutMs),
    idleTimeoutMs: timeout("idleTimeoutMs", timeoutMs),
    nonStreamingTotalTimeoutMs: timeout("nonStreamingTotalTimeoutMs", timeoutMs),
    streamingTotalTimeoutMs: timeout("streamingTotalTimeoutMs", 0, true),
  };
}

function wrapResponse(response, requestController, deadline, detachExternalSignal, limits) {
  if (!response.body) {
    deadline.completed();
    detachExternalSignal();
    return { response, context: null };
  }

  const sourceReader = response.body.getReader();
  let streamController = null;
  let finished = false;
  let totalBytes = 0;

  function cleanup() {
    deadline.completed();
    detachExternalSignal();
    requestController.signal.removeEventListener("abort", onRequestAbort);
  }

  function complete() {
    if (finished) return false;
    finished = true;
    cleanup();
    return true;
  }

  function fail(error, abortRequest = true) {
    if (!complete()) return;
    if (abortRequest && !requestController.signal.aborted) requestController.abort(error);
    sourceReader.cancel(error).catch(() => {});
    try {
      streamController?.error(error);
    } catch {}
  }

  function cancel(reason) {
    if (!complete()) return Promise.resolve();
    if (!requestController.signal.aborted) requestController.abort(reason || abortError());
    return sourceReader.cancel(reason).catch(() => {});
  }

  function onRequestAbort() {
    fail(requestController.signal.reason || abortError(), false);
  }

  const boundedBody = new ReadableStream({
    start(controller) {
      streamController = controller;
    },
    async pull(controller) {
      try {
        const { done, value } = await sourceReader.read();
        if (finished) return;
        if (done) {
          complete();
          controller.close();
          return;
        }
        totalBytes += value.byteLength;
        if (totalBytes > limits.maxResponseBytes) {
          fail(responseLimitError());
          return;
        }
        if (value.byteLength > 0) deadline.dataReceived();
        controller.enqueue(value);
      } catch (error) {
        if (!finished) fail(error?.name === "AbortError" ? error : upstreamError("Upstream response failed.", "UPSTREAM_RESPONSE_FAILED"));
      }
    },
    cancel,
  });

  requestController.signal.addEventListener("abort", onRequestAbort, { once: true });
  if (requestController.signal.aborted) onRequestAbort();

  const wrapped = new Response(boundedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  const context = { fail, cancel, maxSseEventBytes: limits.maxSseEventBytes };
  bodyContexts.set(boundedBody, context);
  return { response: wrapped, context };
}

async function fetchUpstream(upstream, payload, options = {}) {
  const timeoutMs = positiveInteger(upstream.timeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS, "upstream.timeoutMs");
  const maxResponseBytes = positiveInteger(upstream.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "upstream.maxResponseBytes");
  const maxSseEventBytes = positiveInteger(upstream.maxSseEventBytes, DEFAULT_MAX_SSE_EVENT_BYTES, "upstream.maxSseEventBytes");
  const requestController = new AbortController();
  const deadline = createPhaseDeadline({
    controller: requestController,
    policy: phasePolicy(upstream, timeoutMs),
    streaming: payload.stream === true,
    timers: options.timers,
  });
  const onExternalAbort = () => {
    const error = abortError();
    if (!requestController.signal.aborted) requestController.abort(error);
  };
  const detachExternalSignal = () => options.signal?.removeEventListener("abort", onExternalAbort);
  if (options.signal) {
    if (options.signal.aborted) onExternalAbort();
    else options.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  deadline.waitingForHeaders();

  try {
    const response = await fetch(upstreamUrl(upstream), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey(upstream)}`,
        "Content-Type": "application/json",
        Accept: payload.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(payload),
      signal: requestController.signal,
    });
    deadline.headersReceived();
    const wrapped = wrapResponse(response, requestController, deadline, detachExternalSignal, {
      maxResponseBytes,
      maxSseEventBytes,
    });
    if (options.signal?.aborted) onExternalAbort();
    return wrapped.response;
  } catch (error) {
    deadline.cancelled();
    detachExternalSignal();
    throw error;
  }
}

async function fetchUpstreamJson(upstream, payload, options) {
  const response = await fetchUpstream(upstream, { ...payload, stream: false }, options);
  if (!response.ok) {
    await response.text();
    throw new Error(`Upstream HTTP ${response.status}.`);
  }
  return readUpstreamChatCompletion(response);
}

async function readUpstreamChatCompletion(response) {
  const contentType = response.headers.get("content-type") || "";
  const maxSseEventBytes = bodyContexts.get(response.body)?.maxSseEventBytes || DEFAULT_MAX_SSE_EVENT_BYTES;
  const text = await response.text();
  const { completion, normalizedSse } = parseNonStreamChatResponse(text, contentType, { maxSseEventBytes });
  if (normalizedSse) {
    console.error(`[compat] normalized non-stream SSE response status=${response.status} content-type=${contentType || "unknown"}`);
  }
  return completion;
}

async function pipeStream(upstreamBody, res, options = {}) {
  const onChunk = typeof options.onChunk === "function" ? options.onChunk : null;
  const reader = upstreamBody.getReader();
  let aborted = false;
  let failed = false;
  const onClose = () => {
    aborted = true;
    reader.cancel(abortError()).catch(() => {});
  };
  res.on("close", onClose);
  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (onChunk) {
        try { onChunk(value); } catch {}
      }
      if (!(await writeWithBackpressure(res, Buffer.from(value)))) {
        aborted = true;
        await reader.cancel(abortError()).catch(() => {});
        break;
      }
    }
  } catch {
    failed = true;
  } finally {
    res.off("close", onClose);
    if (!aborted) await reader.cancel().catch(() => {});
  }
  if (failed) {
    if (!res.destroyed && typeof res.destroy === "function") res.destroy();
    return;
  }
  if (!aborted && !res.destroyed && !res.writableEnded) res.end();
}

function sseBoundary(buffer) {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0) return crlf < 0 ? null : { index: crlf, length: 4 };
  if (crlf < 0 || lf < crlf) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

async function eachSseData(body, onData, options = {}) {
  const context = bodyContexts.get(body);
  const maxSseEventBytes = positiveInteger(
    options.maxSseEventBytes,
    context?.maxSseEventBytes || DEFAULT_MAX_SSE_EVENT_BYTES,
    "upstream.maxSseEventBytes"
  );
  const reader = body.getReader();
  let buffer = Buffer.alloc(0);
  const onAbort = () => reader.cancel(abortError()).catch(() => {});
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = buffer.length ? Buffer.concat([buffer, Buffer.from(value)]) : Buffer.from(value);
      let boundary;
      while ((boundary = sseBoundary(buffer))) {
        if (boundary.index > maxSseEventBytes) throw eventLimitError();
        const event = buffer.subarray(0, boundary.index).toString("utf8");
        buffer = buffer.subarray(boundary.index + boundary.length);
        const lines = event.split(/\r?\n/).filter((line) => line.startsWith("data:"));
        if (lines.length) await onData(lines.map((line) => line.slice(5).trimStart()).join("\n"));
      }
      if (buffer.length > maxSseEventBytes) throw eventLimitError();
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function abortOnClientClose(res) {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.once("close", onClose);
  if (res.destroyed || res.writableEnded) onClose();
  return {
    signal: controller.signal,
    detach: () => res.off("close", onClose),
  };
}

module.exports = {
  fetchUpstream,
  fetchUpstreamJson,
  readUpstreamChatCompletion,
  pipeStream,
  eachSseData,
  abortOnClientClose,
};
