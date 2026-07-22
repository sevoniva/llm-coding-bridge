"use strict";

const { randomUUID } = require("node:crypto");
const {
  textFromContent,
  toolInputFromArguments,
  parsedToolInput,
  toolArgumentsString,
  parseToolArguments,
} = require("./shared");
const { abortOnClientClose } = require("../upstream");
const { runChatAttempts } = require("../attempt-runner");
const { registerStream } = require("../streams");
const { sendJson, writeSse, writeWithBackpressure } = require("../http-util");
const { startHeartbeat } = require("../heartbeat");

function downstreamClosedError() {
  const error = new Error("Downstream connection closed.");
  error.code = "DOWNSTREAM_CLOSED";
  return error;
}

function responsesInputToMessages(payload) {
  const messages = [];
  if (payload.instructions) messages.push({ role: "system", content: String(payload.instructions) });
  const input = Array.isArray(payload.input) ? payload.input : [payload.input];

  for (const item of input) {
    if (!item) continue;
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: String(item.output || "") });
      continue;
    }
    if (item.type === "custom_tool_call_output" || item.type === "tool_search_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: String(item.output || "") });
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call" || item.type === "tool_search_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: item.call_id || item.id || `call_${randomUUID()}`,
            type: "function",
            function: {
              name: item.type === "tool_search_call" ? "tool_search" : item.name,
              arguments: item.type === "tool_search_call" ? toolArgumentsString(item.arguments) : item.arguments || JSON.stringify({ input: item.input || "" }),
            },
          },
        ],
      });
      continue;
    }
    if (item.type === "message" || item.role) {
      const role = item.role === "developer" ? "system" : item.role || "user";
      messages.push({ role, content: textFromContent(item.content) });
    }
  }

  return messages.length ? messages : [{ role: "user", content: "" }];
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools
    .filter((tool) => tool?.type === "function" || tool?.type === "custom" || tool?.type === "tool_search" || tool?.name)
    .map((tool) => ({
      type: "function",
      function: tool.function || {
        name: tool.type === "tool_search" ? "tool_search" : tool.name,
        description: tool.description || "",
        parameters: tool.parameters || (tool.type === "tool_search"
          ? { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
          : { type: "object", properties: { input: { type: "string" } }, required: ["input"] }),
      },
    }));
  return converted.length ? converted : undefined;
}

function customToolNames(tools) {
  return new Set((Array.isArray(tools) ? tools : []).filter((tool) => tool?.type === "custom").map((tool) => tool.name).filter(Boolean));
}

function toolSearchNames(tools) {
  return new Set((Array.isArray(tools) ? tools : []).filter((tool) => tool?.type === "tool_search").map(() => "tool_search"));
}

function responsesToChatPayload(upstream, payload) {
  const streaming = payload.stream === true;
  const chat = {
    model: upstream.upstreamModel || upstream.model,
    messages: responsesInputToMessages(payload),
    stream: streaming,
  };
  if (streaming) chat.stream_options = { include_usage: true };
  const tools = convertTools(payload.tools);
  if (tools) chat.tools = tools;
  if (payload.tool_choice) chat.tool_choice = payload.tool_choice;
  if (payload.max_output_tokens) chat.max_tokens = payload.max_output_tokens;
  if (Number.isFinite(upstream.temperature)) chat.temperature = upstream.temperature;
  if (upstream.reasoningEffort !== false) chat.reasoning_effort = upstream.reasoningEffort || "none";
  return chat;
}

function buildResponsesOutput(message, customNames = new Set(), searchNames = new Set()) {
  const output = [];
  const text = message?.content || "";
  if (text) {
    output.push({
      id: `msg_${randomUUID()}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const call of message?.tool_calls || []) {
    const name = call.function?.name || call.name;
    if (searchNames.has(name)) {
      output.push({
        type: "tool_search_call",
        status: "completed",
        call_id: call.id || `call_${randomUUID()}`,
        execution: "client",
        arguments: parseToolArguments(call.function?.arguments || call.arguments),
      });
      continue;
    }
    if (customNames.has(name)) {
      output.push({
        id: call.id || `ctc_${randomUUID()}`,
        type: "custom_tool_call",
        status: "completed",
        call_id: call.id || `call_${randomUUID()}`,
        name,
        input: toolInputFromArguments(call.function?.arguments || call.arguments),
      });
      continue;
    }
    output.push({
      id: call.id || `fc_${randomUUID()}`,
      type: "function_call",
      status: "completed",
      call_id: call.id || `call_${randomUUID()}`,
      name,
      arguments: call.function?.arguments || call.arguments || "{}",
    });
  }
  return output;
}

function chatToResponse(upstream, chat) {
  const message = chat.choices?.[0]?.message || {};
  const output = buildResponsesOutput(message);
  const outputText = output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content || [])
    .map((part) => part.text || "")
    .join("");

  return {
    id: `resp_${randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    model: upstream.alias || upstream.model,
    output,
    output_text: outputText,
    parallel_tool_calls: true,
    store: false,
    usage: {
      input_tokens: chat.usage?.prompt_tokens || 0,
      output_tokens: chat.usage?.completion_tokens || 0,
      total_tokens: chat.usage?.total_tokens || 0,
    },
  };
}

function responseUsage(usage) {
  usage ||= {};
  const input = usage.prompt_tokens || usage.input_tokens || 0;
  const output = usage.completion_tokens || usage.output_tokens || 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: usage.total_tokens || input + output,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
}

class ResponsesWriter {
  constructor(model, res = null, customNames = new Set(), searchNames = new Set()) {
    this.model = model;
    this.res = res;
    this.customNames = customNames;
    this.searchNames = searchNames;
    this.id = `resp_${randomUUID()}`;
    this.createdAt = Math.floor(Date.now() / 1000);
    this.sequence = 0;
    this.output = [];
    this.nextOutputIndex = 0;
    this.message = null;
    this.tools = new Map();
    this.toolOrder = [];
    this.closed = false;
  }

  response(status = "in_progress", usage = null) {
    return {
      id: this.id,
      object: "response",
      created_at: this.createdAt,
      status,
      error: null,
      incomplete_details: null,
      model: this.model,
      output: this.output,
      output_text: this.outputText(),
      parallel_tool_calls: false,
      tool_choice: "auto",
      tools: [],
      store: false,
      usage,
    };
  }

  outputText() {
    return this.output
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .map((part) => part.text || "")
      .join("");
  }

  async event(type, body) {
    if (!this.res) return;
    if (this.closed || this.res.destroyed || this.res.writableEnded) {
      this.closed = true;
      throw downstreamClosedError();
    }
    const written = await writeSse(this.res, type, { type, sequence_number: this.sequence, ...body });
    if (!written) {
      this.closed = true;
      throw downstreamClosedError();
    }
    this.sequence += 1;
  }

  async start() {
    if (!this.res) return;
    if (this.res.destroyed || this.res.writableEnded) throw downstreamClosedError();
    this.res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    registerStream(this.res, () => {
      void this.fail("Server shutting down.", "server_shutdown").catch(() => {
        if (!this.res.destroyed) this.res.destroy();
      });
    });
    await this.event("response.created", { response: this.response() });
    await this.event("response.in_progress", { response: this.response() });
  }

  async ensureMessage() {
    if (this.message) return this.message;
    this.message = {
      id: `msg_${randomUUID()}`,
      outputIndex: this.nextOutputIndex,
      text: "",
    };
    this.nextOutputIndex += 1;
    await this.event("response.output_item.added", {
      output_index: this.message.outputIndex,
      item: { id: this.message.id, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    await this.event("response.content_part.added", {
      item_id: this.message.id,
      output_index: this.message.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    return this.message;
  }

  async textDelta(delta) {
    if (!delta) return;
    const message = await this.ensureMessage();
    message.text += delta;
    await this.event("response.output_text.delta", {
      item_id: message.id,
      output_index: message.outputIndex,
      content_index: 0,
      delta,
    });
  }

  async finishMessage() {
    if (!this.message) return;
    const part = { type: "output_text", text: this.message.text, annotations: [] };
    const item = {
      id: this.message.id,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [part],
    };
    await this.event("response.output_text.done", {
      item_id: this.message.id,
      output_index: this.message.outputIndex,
      content_index: 0,
      text: this.message.text,
    });
    await this.event("response.content_part.done", {
      item_id: this.message.id,
      output_index: this.message.outputIndex,
      content_index: 0,
      part,
    });
    await this.event("response.output_item.done", { output_index: this.message.outputIndex, item });
    this.output.push(item);
    this.message = null;
  }

  async toolDelta(index, callId, name, argumentsDelta) {
    await this.finishMessage();
    if (!this.tools.has(index)) {
      const custom = this.customNames.has(name);
      const search = this.searchNames.has(name);
      const tool = {
        itemId: `${custom ? "ctc" : "fc"}_${randomUUID()}`,
        callId: callId || `call_${randomUUID()}`,
        name: name || "",
        arguments: "",
        input: "",
        outputIndex: this.nextOutputIndex,
        custom,
        search,
      };
      this.nextOutputIndex += 1;
      this.tools.set(index, tool);
      this.toolOrder.push(index);
      await this.event("response.output_item.added", {
        output_index: tool.outputIndex,
        item: tool.search
          ? { type: "tool_search_call", status: "in_progress", call_id: tool.callId, execution: "client", arguments: {} }
          : tool.custom
          ? { id: tool.itemId, type: "custom_tool_call", status: "in_progress", call_id: tool.callId, name: tool.name, input: "" }
          : { id: tool.itemId, type: "function_call", status: "in_progress", call_id: tool.callId, name: tool.name, arguments: "" },
      });
    }
    const tool = this.tools.get(index);
    if (callId) tool.callId = callId;
    if (name) {
      tool.name = name;
      tool.custom ||= this.customNames.has(name);
      tool.search ||= this.searchNames.has(name);
    }
    if (argumentsDelta) {
      tool.arguments += argumentsDelta;
      if (tool.search) return;
      if (tool.custom) {
        const input = parsedToolInput(tool.arguments);
        if (input === null) return;
        const delta = input.slice(tool.input.length);
        tool.input = input;
        if (!delta) return;
        await this.event("response.custom_tool_call_input.delta", {
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          delta,
        });
        return;
      }
      await this.event("response.function_call_arguments.delta", {
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        delta: argumentsDelta,
      });
    }
  }

  async finishTools() {
    for (const index of this.toolOrder) {
      const tool = this.tools.get(index);
      const item = tool.search
        ? { type: "tool_search_call", status: "completed", call_id: tool.callId, execution: "client", arguments: parseToolArguments(tool.arguments) }
        : tool.custom
        ? { id: tool.itemId, type: "custom_tool_call", status: "completed", call_id: tool.callId, name: tool.name, input: toolInputFromArguments(tool.arguments) }
        : { id: tool.itemId, type: "function_call", status: "completed", call_id: tool.callId, name: tool.name, arguments: tool.arguments };
      if (!tool.search) {
        await this.event(tool.custom ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done", {
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          [tool.custom ? "input" : "arguments"]: tool.custom ? item.input : tool.arguments,
        });
      }
      await this.event("response.output_item.done", { output_index: tool.outputIndex, item });
      this.output.push(item);
    }
    this.tools.clear();
    this.toolOrder = [];
  }

  async complete(usage) {
    await this.finishMessage();
    await this.finishTools();
    const response = this.response("completed", responseUsage(usage));
    if (this.res && !this.res.destroyed && !this.res.writableEnded) {
      await this.event("response.completed", { response });
      if (!(await writeWithBackpressure(this.res, "data: [DONE]\n\n"))) throw downstreamClosedError();
      this.res.end();
    }
    return response;
  }

  async fail(message = "Upstream error.", code = "upstream_error") {
    await this.finishMessage();
    await this.finishTools();
    const response = this.response("failed");
    response.error = { message, code };
    if (this.res && !this.res.destroyed && !this.res.writableEnded) {
      await this.event("response.failed", { response });
      if (!(await writeWithBackpressure(this.res, "data: [DONE]\n\n"))) throw downstreamClosedError();
      this.res.end();
    }
    return response;
  }
}

async function handleResponsesRequest(upstream, payload, res, signal, heartbeatIntervalMs, runtime) {
  const chatPayload = responsesToChatPayload(upstream, payload);
  const writer = new ResponsesWriter(upstream.alias || upstream.model, payload.stream ? res : null, customToolNames(payload.tools), toolSearchNames(payload.tools));
  // For streaming requests, emit response.created + response.in_progress BEFORE
  // awaiting the upstream so clients with short idle timeouts (e.g. ZCode
  // subagents) see activity immediately, then keep them alive with heartbeats
  // while the upstream "thinks". For non-streaming, writer.start() is a no-op
  // (res is null) and we still fetch-then-JSON at the end.
  if (payload.stream) {
    try {
      await writer.start();
    } catch {
      // Client already gone; nothing to do.
      return;
    }
  }
  const heartbeat = payload.stream ? startHeartbeat(res, heartbeatIntervalMs, {
    onHeartbeat: () => runtime.requestState.recordHeartbeat(),
  }) : null;
  let usage = null;
  const applyCompletion = async (data) => {
    usage = data.usage || usage;
    const message = data.choices?.[0]?.message || {};
    if (message.content) await writer.textDelta(message.content);
    for (const [index, call] of (message.tool_calls || []).entries()) {
      const fn = call.function || {};
      await writer.toolDelta(index, call.id, fn.name, fn.arguments || "");
    }
  };
  try {
    await runChatAttempts({
      route: upstream,
      payload: chatPayload,
      ...runtime,
      signal,
      onData: async (data) => {
        heartbeat?.touch();
        if (data === "[DONE]") return;
        let chunk;
        try { chunk = JSON.parse(data); } catch { return; }
        usage = chunk.usage || usage;
        for (const choice of chunk.choices || []) {
          const delta = choice.delta || {};
          if (delta.content) await writer.textDelta(delta.content);
          for (const call of delta.tool_calls || []) {
            const fn = call.function || {};
            await writer.toolDelta(call.index || 0, call.id, fn.name, fn.arguments || "");
          }
        }
      },
      onJsonCompletion: applyCompletion,
    });
  } catch (error) {
    if (heartbeat) heartbeat.stop();
    if (!payload.stream) {
      const status = error.status || (error.retryable ? 502 : 500);
      sendJson(res, status, { error: { message: error.status ? `Upstream HTTP ${error.status}.` : "Upstream request failed.", type: "upstream_error" } });
      return;
    }
    if (error.retryable) {
      if (!res.destroyed && !res.writableEnded) res.destroy();
      return;
    }
    try {
      await writer.fail(error.status ? `Upstream HTTP ${error.status}.` : "Upstream request failed.", "upstream_error");
    } catch {
      if (!res.destroyed && typeof res.destroy === "function") res.destroy();
    }
    return;
  }
  if (heartbeat) heartbeat.stop();

  const response = await writer.complete(usage);
  if (!payload.stream) sendJson(res, 200, response);
}

async function handleResponses(upstream, payload, res, heartbeatIntervalMs, runtime) {
  const client = abortOnClientClose(res);
  try {
    return await handleResponsesRequest(upstream, payload, res, client.signal, heartbeatIntervalMs, runtime);
  } finally {
    client.detach();
  }
}

module.exports = {
  responsesInputToMessages,
  responsesToChatPayload,
  buildResponsesOutput,
  chatToResponse,
  ResponsesWriter,
  handleResponses,
  responseUsage,
};
