"use strict";

const { randomUUID } = require("node:crypto");
const { anthropicText, approxTokens } = require("./shared");
const { fetchUpstream } = require("../upstream");
const { registerStream } = require("../streams");
const { sendJson, writeSse } = require("../http-util");

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
    model: upstream.model,
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
    model: upstream.model,
    content,
    stop_reason: message.tool_calls?.length ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: chat.usage?.prompt_tokens || 0,
      output_tokens: chat.usage?.completion_tokens || approxTokens(message.content || ""),
    },
  };
}

function streamAnthropic(res, message) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  registerStream(res);
  writeSse(res, "message_start", { type: "message_start", message: { ...message, content: [] } });
  message.content.forEach((block, index) => {
    const emptyBlock = block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} };
    writeSse(res, "content_block_start", { type: "content_block_start", index, content_block: emptyBlock });
    if (block.type === "text") {
      writeSse(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
    } else if (block.type === "tool_use") {
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) },
      });
    }
    writeSse(res, "content_block_stop", { type: "content_block_stop", index });
  });
  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  });
  writeSse(res, "message_stop", { type: "message_stop" });
  res.end();
}

async function handleAnthropicMessages(upstream, payload, res) {
  const upstreamRes = await fetchUpstream(upstream, { ...anthropicToChatPayload(upstream, payload), stream: false });
  const text = await upstreamRes.text();
  if (!upstreamRes.ok) {
    sendJson(res, upstreamRes.status, { type: "error", error: { type: "api_error", message: "Upstream error." } });
    return;
  }
  const chat = JSON.parse(text);
  const message = chatToAnthropic(upstream, chat);
  if (payload.stream) streamAnthropic(res, message);
  else sendJson(res, 200, message);
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
