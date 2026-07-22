"use strict";

const { randomUUID } = require("node:crypto");
const { sanitizeChatPayload } = require("../chat-compat");
const { abortOnClientClose } = require("../upstream");
const { runChatAttempts } = require("../attempt-runner");
const { registerStream } = require("../streams");
const { sendJson, writeWithBackpressure } = require("../http-util");
const { startHeartbeat, recordHeartbeat } = require("../heartbeat");
const { logRequestEvent } = require("../request-log");

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

function sseErrorFrame(message, type = "upstream_error") {
  return `data: ${JSON.stringify({ error: { message, type } })}\n\n`;
}

function downstreamClosedError() {
  const error = new Error("Downstream connection closed.");
  error.code = "DOWNSTREAM_CLOSED";
  return error;
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

function clientChatData(data, model) {
  if (data === "[DONE]") return data;
  try {
    const event = JSON.parse(data);
    if (!event || typeof event !== "object" || Array.isArray(event) || !Object.hasOwn(event, "model")) return data;
    return JSON.stringify({ ...event, model });
  } catch {
    return data;
  }
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

async function handleChat(upstream, payload, res, heartbeatIntervalMs, requestLogContext, runtime) {
  const clientModel = upstream.alias || upstream.model;
  const upstreamPayload = { ...sanitizeChatPayload(payload, upstream), model: upstream.upstreamModel || upstream.model };
  const client = abortOnClientClose(res);
  logRequestEvent(requestLogContext, "request_start", {}, runtime.eventStore);
  try {
    if (!payload.stream) {
      let completion;
      try {
        const result = await runChatAttempts({
          route: upstream,
          payload: upstreamPayload,
          ...runtime,
          signal: client.signal,
          onHeaders: (response) => logRequestEvent(requestLogContext, "upstream_headers", { status: response.status }, runtime.eventStore),
          onJsonCompletion: (value) => { completion = value; },
        });
        completion ||= result.completion;
      } catch (error) {
        logRequestEvent(requestLogContext, "upstream_error", { status: error.status, error }, runtime.eventStore);
        const status = error.status || (error.retryable ? 502 : 500);
        sendJson(res, status, { error: { message: error.status ? `Upstream HTTP ${error.status}.` : "Upstream request failed.", type: "upstream_error" } });
        return;
      }
      sendJson(res, 200, { ...completion, model: clientModel });
      return;
    }

    // Streaming path: commit SSE headers BEFORE awaiting the upstream, then send
    // protocol-valid empty completion chunks during every upstream idle gap.
    res.writeHead(200, SSE_HEADERS);
    const heartbeat = startHeartbeat(res, heartbeatIntervalMs, {
      frame: chatHeartbeatFrame(clientModel),
      onHeartbeat: () => recordHeartbeat(runtime, clientModel),
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

    try {
      await runChatAttempts({
        route: upstream,
        payload: upstreamPayload,
        ...runtime,
        signal: client.signal,
        onHeaders: (response) => logRequestEvent(requestLogContext, "upstream_headers", { status: response.status }, runtime.eventStore),
        onData: async (data) => {
          heartbeat.touch();
          if (!(await writeWithBackpressure(res, `data: ${clientChatData(data, clientModel)}\n\n`))) {
            throw downstreamClosedError();
          }
        },
        onJsonCompletion: async (completion, response) => {
          heartbeat.stop();
          if (!(await writeJsonCompletionAsSse(res, { ...completion, model: clientModel }, clientModel))) {
            throw downstreamClosedError();
          }
          logRequestEvent(requestLogContext, "upstream_json_fallback", { status: response.status }, runtime.eventStore);
        },
      });
    } catch (error) {
      heartbeat.stop();
      if (streamTerminated || res.destroyed || res.writableEnded || client.signal.aborted) return;
      logRequestEvent(requestLogContext, "upstream_error", { status: error.status, error }, runtime.eventStore);
      if (error.retryable) res.destroy();
      else await writeSseErrorAndDone(res, error.status ? `Upstream HTTP ${error.status}.` : "Upstream request failed.", "upstream_error");
      return;
    }
    heartbeat.stop();
    if (!res.destroyed && !res.writableEnded) res.end();
  } finally {
    client.detach();
    logRequestEvent(requestLogContext, "request_complete", { status: res.statusCode }, runtime.eventStore);
  }
}

module.exports = { handleChat };
