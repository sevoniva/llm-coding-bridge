"use strict";

const { randomUUID } = require("node:crypto");
const { sanitizeChatPayload } = require("../chat-compat");
const { fetchUpstream, readUpstreamChatCompletion, pipeStream, abortOnClientClose } = require("../upstream");
const { registerStream } = require("../streams");
const { sendJson, writeWithBackpressure } = require("../http-util");
const { startHeartbeat } = require("../heartbeat");
const { logRequestEvent } = require("../request-log");

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

function sseErrorFrame(message, type = "upstream_error") {
  return `data: ${JSON.stringify({ error: { message, type } })}\n\n`;
}

function chatHeartbeatFrame(model) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-bridge-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  })}\n\n`;
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

function jsonCompletionChunk(completion, fallbackModel) {
  if (completion?.error || !Array.isArray(completion?.choices) || completion.choices.length === 0) {
    const error = new Error("Upstream JSON response was not a chat completion.");
    error.code = "UPSTREAM_NON_SSE_RESPONSE";
    if (typeof completion?.error?.code === "string") error.cause = { code: completion.error.code };
    throw error;
  }
  const choices = completion.choices.map((choice, choiceIndex) => {
    if (!choice || typeof choice !== "object") {
      throw new Error("Upstream JSON completion contained an invalid choice.");
    }
    if (choice.delta && typeof choice.delta === "object") {
      return { ...choice, index: Number.isInteger(choice.index) ? choice.index : choiceIndex };
    }
    const message = choice.message;
    if (!message || typeof message !== "object") {
      throw new Error("Upstream JSON completion choice did not contain a message.");
    }
    const delta = { role: message.role || "assistant" };
    for (const key of ["content", "reasoning_content", "reasoning", "refusal"]) {
      if (Object.hasOwn(message, key)) delta[key] = message[key];
    }
    if (Array.isArray(message.tool_calls)) {
      delta.tool_calls = message.tool_calls.map((toolCall, toolIndex) => ({
        ...toolCall,
        index: Number.isInteger(toolCall?.index) ? toolCall.index : toolIndex,
      }));
    }
    return {
      index: Number.isInteger(choice.index) ? choice.index : choiceIndex,
      delta,
      finish_reason: Object.hasOwn(choice, "finish_reason") ? choice.finish_reason : null,
      ...(Object.hasOwn(choice, "logprobs") ? { logprobs: choice.logprobs } : {}),
    };
  });
  return {
    id: completion.id || `chatcmpl-bridge-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: completion.created || Math.floor(Date.now() / 1000),
    model: completion.model || fallbackModel,
    choices,
    ...(Object.hasOwn(completion, "system_fingerprint") ? { system_fingerprint: completion.system_fingerprint } : {}),
    ...(Object.hasOwn(completion, "service_tier") ? { service_tier: completion.service_tier } : {}),
  };
}

async function writeJsonCompletionAsSse(res, completion, fallbackModel) {
  const chunk = jsonCompletionChunk(completion, fallbackModel);
  if (!(await writeWithBackpressure(res, `data: ${JSON.stringify(chunk)}\n\n`))) return false;
  if (completion.usage) {
    const usageChunk = { ...chunk, choices: [], usage: completion.usage };
    if (!(await writeWithBackpressure(res, `data: ${JSON.stringify(usageChunk)}\n\n`))) return false;
  }
  if (!(await writeWithBackpressure(res, "data: [DONE]\n\n"))) return false;
  if (!res.writableEnded) res.end();
  return true;
}

async function handleChat(upstream, payload, res, heartbeatIntervalMs, requestLogContext) {
  const clientModel = upstream.alias || upstream.model;
  const upstreamPayload = { ...sanitizeChatPayload(payload, upstream), model: upstream.upstreamModel || upstream.model };
  const client = abortOnClientClose(res);
  logRequestEvent(requestLogContext, "request_start");
  try {
    // Non-streaming path: unchanged. Fetch then send a single JSON response.
    if (!payload.stream) {
      let upstreamRes;
      try {
        upstreamRes = await fetchUpstream(upstream, upstreamPayload, { signal: client.signal });
      } catch (error) {
        logRequestEvent(requestLogContext, "upstream_transport_error", { error });
        throw error;
      }
      logRequestEvent(requestLogContext, "upstream_headers", { status: upstreamRes.status });
      if (!upstreamRes.ok) {
        await upstreamRes.text();
        sendJson(res, upstreamRes.status, { error: { message: `Upstream HTTP ${upstreamRes.status}.`, type: "upstream_error" } });
        return;
      }
      const completion = await readUpstreamChatCompletion(upstreamRes);
      sendJson(res, upstreamRes.status, { ...completion, model: clientModel });
      return;
    }

    // Streaming path: commit SSE headers BEFORE awaiting the upstream, then send
    // protocol-valid empty completion chunks during every upstream idle gap.
    res.writeHead(200, SSE_HEADERS);
    const heartbeat = startHeartbeat(res, heartbeatIntervalMs, {
      frame: chatHeartbeatFrame(clientModel),
    });
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
      if (streamTerminated || res.destroyed || res.writableEnded || client.signal.aborted) return;
      logRequestEvent(requestLogContext, "upstream_transport_error", { error });
      res.destroy();
      return;
    }
    logRequestEvent(requestLogContext, "upstream_headers", { status: upstreamRes.status });

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

    // Some compatible upstreams intermittently ignore stream:true and answer
    // with a normal JSON chat completion. Convert that completion to downstream
    // SSE so an otherwise healthy long-running agent turn can continue.
    const contentType = upstreamRes.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      heartbeat.stop();
      if (streamTerminated) return;
      try {
        const completion = await readUpstreamChatCompletion(upstreamRes);
        await writeJsonCompletionAsSse(res, { ...completion, model: clientModel }, clientModel);
        logRequestEvent(requestLogContext, "upstream_json_fallback", { status: upstreamRes.status });
      } catch (error) {
        logRequestEvent(requestLogContext, "upstream_protocol_error", { status: upstreamRes.status, error });
        if (streamTerminated || res.destroyed || res.writableEnded || client.signal.aborted) return;
        res.destroy();
      }
      return;
    }

    await pipeStream(upstreamRes.body, res, { onChunk: () => heartbeat.touch() });
    heartbeat.stop();
  } finally {
    client.detach();
    logRequestEvent(requestLogContext, "request_complete", { status: res.statusCode });
  }
}

module.exports = { handleChat };
