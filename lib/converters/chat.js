"use strict";

const { sanitizeChatPayload } = require("../chat-compat");
const { fetchUpstream, readUpstreamChatCompletion, pipeStream, abortOnClientClose } = require("../upstream");
const { registerStream } = require("../streams");
const { sendJson, writeWithBackpressure } = require("../http-util");
const { startHeartbeat } = require("../heartbeat");

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

function sseErrorFrame(message, type = "upstream_error") {
  return `data: ${JSON.stringify({ error: { message, type } })}\n\n`;
}

async function writeSseErrorAndDone(res, message, type) {
  if (res.destroyed || res.writableEnded) return;
  if (!(await writeWithBackpressure(res, sseErrorFrame(message, type)))) {
    if (!res.destroyed) res.destroy();
    return;
  }
  if (!(await writeWithBackpressure(res, "data: [DONE]\n\n"))) {
    if (!res.destroyed) res.destroy();
    return;
  }
  if (!res.writableEnded) res.end();
}

async function handleChat(upstream, payload, res, heartbeatIntervalMs) {
  const upstreamPayload = { ...sanitizeChatPayload(payload, upstream), model: upstream.model };
  const client = abortOnClientClose(res);
  try {
    // Non-streaming path: unchanged. Fetch then send a single JSON response.
    if (!payload.stream) {
      const upstreamRes = await fetchUpstream(upstream, upstreamPayload, { signal: client.signal });
      if (!upstreamRes.ok) {
        await upstreamRes.text();
        sendJson(res, upstreamRes.status, { error: { message: `Upstream HTTP ${upstreamRes.status}.`, type: "upstream_error" } });
        return;
      }
      sendJson(res, upstreamRes.status, await readUpstreamChatCompletion(upstreamRes));
      return;
    }

    // Streaming path: commit SSE headers BEFORE awaiting the upstream, then keep
    // the client alive with `: ping` comment frames while the upstream "thinks".
    // Clients (e.g. ZCode subagents) with short idle timeouts would otherwise
    // cancel the request before the upstream's first byte arrives.
    res.writeHead(200, SSE_HEADERS);
    const heartbeat = startHeartbeat(res, heartbeatIntervalMs);
    let streamTerminated = false;
    registerStream(res, () => {
      streamTerminated = true;
      heartbeat.stop();
      void (async () => {
        if (!(await writeWithBackpressure(res, "data: [DONE]\n\n"))) {
          if (!res.destroyed) res.destroy();
          return;
        }
        if (!res.writableEnded) res.end();
      })().catch(() => {
        if (!res.destroyed) res.destroy();
      });
    });

    let upstreamRes;
    try {
      upstreamRes = await fetchUpstream(upstream, upstreamPayload, { signal: client.signal });
    } catch (error) {
      heartbeat.stop();
      if (streamTerminated) return;
      await writeSseErrorAndDone(res, "Upstream request failed.", "upstream_error");
      return;
    }

    if (!upstreamRes.ok) {
      heartbeat.stop();
      await upstreamRes.text();
      if (streamTerminated) return;
      await writeSseErrorAndDone(res, `Upstream HTTP ${upstreamRes.status}.`, "upstream_error");
      return;
    }
    if (!upstreamRes.body) {
      heartbeat.stop();
      if (streamTerminated) return;
      await writeSseErrorAndDone(res, "Upstream returned an empty response.", "upstream_error");
      return;
    }

    // Content-Type passthrough is no longer possible (headers already sent as
    // text/event-stream). If the upstream ignored stream:true and answered with
    // a non-SSE body (e.g. application/json), we must not pipe raw JSON bytes
    // into an SSE stream — emit a clean SSE error frame instead.
    const contentType = upstreamRes.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      heartbeat.stop();
      await upstreamRes.text();
      if (streamTerminated) return;
      await writeSseErrorAndDone(res, "Upstream returned a non-SSE response to a streaming request.", "upstream_error");
      return;
    }

    // Stop the heartbeat as soon as the first real upstream byte arrives; if
    // the stream stalls again mid-way, the upstream timeout (lib/upstream.js)
    // governs the deadline rather than the client idle window.
    await pipeStream(upstreamRes.body, res, { onFirstByte: () => heartbeat.stop() });
    heartbeat.stop();
  } finally {
    client.detach();
  }
}

module.exports = { handleChat };
