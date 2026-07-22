"use strict";

const { randomUUID } = require("node:crypto");
const { anthropicText, approxTokens } = require("./shared");
const { fetchUpstream, readUpstreamChatCompletion, abortOnClientClose } = require("../upstream");
const { registerStream } = require("../streams");
const { sendJson, writeSse, writeWithBackpressure } = require("../http-util");
const { startHeartbeat } = require("../heartbeat");

function anthropicToChatPayload(upstream, payload) {
  const messages = [];
  if (payload.system) messages.push({ role: "system", content: anthropicText(payload.system) || String(payload.system) });
  for (const item of payload.messages || []) {
    if (item.role === "assistant" && Array.isArray(item.content)) {
      const toolCalls = item.content
        .filter((part) => part.type === "tool_use")
        .map((part) => ({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
        }));
      const text = anthropicText(item.content);
      messages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    const toolResults = Array.isArray(item.content) ? item.content.filter((part) => part.type === "tool_result") : [];
    for (const result of toolResults) {
      messages.push({ role: "tool", tool_call_id: result.tool_use_id, content: anthropicText(result.content) || String(result.content || "") });
    }
    const text = anthropicText(item.content);
    if (text || !toolResults.length) messages.push({ role: item.role || "user", content: text });
  }

  const chat = {
    model: upstream.upstreamModel || upstream.model,
    messages,
    stream: false,
  };
  if (payload.max_tokens) chat.max_tokens = payload.max_tokens;
  if (Number.isFinite(upstream.temperature)) chat.temperature = upstream.temperature;
  if (upstream.reasoningEffort !== false) chat.reasoning_effort = upstream.reasoningEffort || "none";
  const tools = Array.isArray(payload.tools)
    ? payload.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.input_schema || { type: "object", properties: {} },
        },
      }))
    : [];
  if (tools.length) {
    chat.tools = tools;
    chat.tool_choice = "auto";
  }
  return chat;
}

function chatToAnthropic(upstream, chat) {
  const message = chat.choices?.[0]?.message || {};
  const content = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(call.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({ type: "tool_use", id: call.id, name: call.function?.name || call.name, input });
  }
  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: upstream.alias || upstream.model,
    content,
    stop_reason: message.tool_calls?.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: chat.usage?.prompt_tokens || 0,
      output_tokens: chat.usage?.completion_tokens || approxTokens(message.content || ""),
    },
  };
}

// Begins an Anthropic SSE stream: commits headers + registers the graceful
// shutdown callback. Split out so handleAnthropicMessages can start the stream
// BEFORE awaiting the (fully-buffered) upstream, keeping the client alive with
// heartbeats during the upstream "thinking" period.
async function beginAnthropicStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  registerStream(res, () => {
    void (async () => {
      const written = await writeSse(res, "error", { type: "error", error: { type: "overloaded_error", message: "Server shutting down." } });
      if (written && !res.writableEnded) res.end();
      else if (!res.destroyed) res.destroy();
    })().catch(() => {
      if (!res.destroyed) res.destroy();
    });
  });
}

// Emits the Anthropic SSE event chain for a complete buffered message. Assumes
// headers were already sent (by beginAnthropicStream or by streamAnthropic).
async function streamAnthropicEvents(res, message) {
  if (!(await writeSse(res, "message_start", { type: "message_start", message: { ...message, content: [] } }))) return;
  for (const [index, block] of message.content.entries()) {
    const emptyBlock = block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} };
    if (!(await writeSse(res, "content_block_start", { type: "content_block_start", index, content_block: emptyBlock }))) return;
    if (block.type === "text") {
      if (!(await writeSse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }))) return;
    } else if (block.type === "tool_use") {
      if (!(await writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) },
      }))) return;
    }
    if (!(await writeSse(res, "content_block_stop", { type: "content_block_stop", index }))) return;
  }
  if (!(await writeSse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  }))) return;
  if (!(await writeSse(res, "message_stop", { type: "message_stop" }))) return;
  if (!res.destroyed && !res.writableEnded) res.end();
}

// Public API: writes headers + full event chain. Preserved for backward
// compatibility (testAnthropicSseHonorsBackpressure calls this directly).
async function streamAnthropic(res, message) {
  await beginAnthropicStream(res);
  await streamAnthropicEvents(res, message);
}

// Emits an Anthropic SSE error event followed by stream end. Used on the
// streaming path after headers are already committed (so we cannot fall back
// to a JSON error response).
async function streamAnthropicError(res, message) {
  if (res.destroyed || res.writableEnded) return;
  if (!(await writeSse(res, "error", { type: "error", error: { type: "api_error", message } }))) {
    if (!res.destroyed && typeof res.destroy === "function") res.destroy();
    return;
  }
  if (!res.destroyed && !res.writableEnded) res.end();
}

async function handleAnthropicMessages(upstream, payload, res, heartbeatIntervalMs) {
  const client = abortOnClientClose(res);
  try {
    // For streaming requests, commit SSE headers + start a heartbeat BEFORE
    // awaiting the upstream. The Anthropic path is fully buffered (stream:
    // false to upstream), so without this the client would see zero bytes for
    // the entire upstream response time and could time out (ZCode subagents).
    let heartbeat = null;
    if (payload.stream) {
      try {
        await beginAnthropicStream(res);
      } catch {
        return; // client gone
      }
      heartbeat = startHeartbeat(res, heartbeatIntervalMs);
    }
    let upstreamRes;
    try {
      upstreamRes = await fetchUpstream(upstream, { ...anthropicToChatPayload(upstream, payload), stream: false }, { signal: client.signal });
    } catch (error) {
      if (heartbeat) heartbeat.stop();
      if (!payload.stream) throw error; // preserved: server.js emits HTTP 500
      await streamAnthropicError(res, "Upstream request failed.");
      return;
    }
    if (!upstreamRes.ok) {
      if (heartbeat) heartbeat.stop();
      await upstreamRes.text();
      if (payload.stream) {
        await streamAnthropicError(res, "Upstream error.");
        return;
      }
      sendJson(res, upstreamRes.status, { type: "error", error: { type: "api_error", message: "Upstream error." } });
      return;
    }
    const chat = await readUpstreamChatCompletion(upstreamRes);
    if (heartbeat) heartbeat.stop();
    const message = chatToAnthropic(upstream, chat);
    if (payload.stream) await streamAnthropicEvents(res, message);
    else sendJson(res, 200, message);
  } finally {
    client.detach();
  }
}

function handleAnthropicTokenCount(payload, res) {
  const text = [
    payload.system ? anthropicText(payload.system) || String(payload.system) : "",
    ...(payload.messages || []).map((message) => anthropicText(message.content)),
  ].join("\n");
  sendJson(res, 200, { input_tokens: approxTokens(text) });
}

module.exports = {
  anthropicToChatPayload,
  chatToAnthropic,
  streamAnthropic,
  handleAnthropicMessages,
  handleAnthropicTokenCount,
};
