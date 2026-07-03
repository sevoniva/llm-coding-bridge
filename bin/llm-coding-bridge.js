#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const readline = require("node:readline/promises");

const DEFAULT_CONFIG = "llm-coding-bridge.config.json";

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "help";
  const args = { command, config: DEFAULT_CONFIG, out: DEFAULT_CONFIG, name: "llm-coding-bridge", home: os.homedir(), lines: 80 };
  if (command === "template" && argv[0] && !argv[0].startsWith("-")) args.template = argv.shift();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") args.config = argv[++i];
    else if (arg === "--out" || arg === "-o") args.out = argv[++i];
    else if (arg === "--name") args.name = argv[++i];
    else if (arg === "--home") args.home = argv[++i];
    else if (arg === "--lines") args.lines = Number(argv[++i]);
    else if (arg === "--force") args.force = true;
    else if (arg === "--deep") args.deep = true;
    else if (arg === "--tools") args.tools = true;
    else if (arg === "--no-doctor") args.doctor = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:
  llm-coding-bridge init --out llm-coding-bridge.config.json
  llm-coding-bridge serve --config llm-coding-bridge.config.json
  llm-coding-bridge doctor --config llm-coding-bridge.config.json
  llm-coding-bridge doctor --deep --config llm-coding-bridge.config.json
  llm-coding-bridge doctor --tools --config llm-coding-bridge.config.json
  llm-coding-bridge status --config llm-coding-bridge.config.json
  llm-coding-bridge codex-profile --config llm-coding-bridge.config.json --name bridge
  llm-coding-bridge template codex
  llm-coding-bridge template codex-desktop
  llm-coding-bridge template claude
  llm-coding-bridge logs --lines 80
  llm-coding-bridge install-service --config ~/.llm-coding-bridge/config.json
  llm-coding-bridge restart-service --config ~/.llm-coding-bridge/config.json
  llm-coding-bridge uninstall-service`;
}

function loadConfig(file) {
  const configPath = path.resolve(file);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const server = { host: "127.0.0.1", port: 18080, ...(config.server || {}) };
  const upstream = config.upstream || {};
  if (!upstream.baseUrl) throw new Error("Missing upstream.baseUrl.");
  if (!upstream.model) throw new Error("Missing upstream.model.");
  if (!upstream.apiKeyEnv && !upstream.apiKeyCommand) {
    throw new Error("Missing upstream.apiKeyEnv or upstream.apiKeyCommand.");
  }
  return { path: configPath, server, upstream };
}

function getApiKey(upstream) {
  if (upstream.apiKeyEnv && process.env[upstream.apiKeyEnv]) {
    return process.env[upstream.apiKeyEnv];
  }
  if (!upstream.apiKeyCommand) {
    throw new Error(`Missing API key env: ${upstream.apiKeyEnv}`);
  }

  const command = upstream.apiKeyCommand;
  const result =
    typeof command === "string"
      ? spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" })
      : spawnSync(command.command, command.args || [], { encoding: "utf8" });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`apiKeyCommand exited with ${result.status}.`);
  const token = result.stdout.trim();
  if (!token) throw new Error("apiKeyCommand returned an empty token.");
  return token;
}

function upstreamUrl(upstream) {
  return `${upstream.baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function localUrl(config, pathname = "") {
  return `http://${config.server.host}:${config.server.port}${pathname}`;
}

async function fetchLocalJson(config, method, pathname, body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(localUrl(config, pathname), {
      method,
      headers: { "Content-Type": "application/json", Authorization: "Bearer local", "x-api-key": "local" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function debug(message) {
  if (process.env.LLM_CODING_BRIDGE_DEBUG) console.error(`[debug] ${message}`);
}

function writeSse(res, event, body) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

async function fetchUpstream(config, payload) {
  const timeoutMs = Number(config.upstream.timeoutMs || 600000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(upstreamUrl(config.upstream), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey(config.upstream)}`,
        "Content-Type": "application/json",
        Accept: payload.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstreamJson(config, payload) {
  const response = await fetchUpstream(config, { ...payload, stream: false });
  const text = await response.text();
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}.`);
  return JSON.parse(text);
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.input_text || part?.output_text || "";
    })
    .filter(Boolean)
    .join("\n");
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

function toolInputFromArguments(value) {
  const raw = String(value || "");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch {}
  return raw;
}

function parsedToolInput(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && typeof parsed.input === "string" ? parsed.input : null;
  } catch {
    return null;
  }
}

function toolArgumentsString(value, fallback = "{}") {
  if (typeof value === "string") return value || fallback;
  if (value && typeof value === "object") return JSON.stringify(value);
  return fallback;
}

function parseToolArguments(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function responsesToChatPayload(config, payload) {
  const chat = {
    model: config.upstream.model,
    messages: responsesInputToMessages(payload),
    stream: true,
    stream_options: { include_usage: true },
  };
  const tools = convertTools(payload.tools);
  if (tools) chat.tools = tools;
  if (payload.tool_choice) chat.tool_choice = payload.tool_choice;
  if (payload.max_output_tokens) chat.max_tokens = payload.max_output_tokens;
  if (Number.isFinite(config.upstream.temperature)) chat.temperature = config.upstream.temperature;
  if (config.upstream.reasoningEffort !== false) chat.reasoning_effort = config.upstream.reasoningEffort || "none";
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

function chatToResponse(config, chat) {
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
    model: config.upstream.model,
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

function approxTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function anthropicText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" || typeof part === "string")
    .map((part) => (typeof part === "string" ? part : part.text || ""))
    .join("\n");
}

function anthropicToChatPayload(config, payload) {
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
    model: config.upstream.model,
    messages,
    stream: false,
  };
  if (payload.max_tokens) chat.max_tokens = payload.max_tokens;
  if (Number.isFinite(config.upstream.temperature)) chat.temperature = config.upstream.temperature;
  if (config.upstream.reasoningEffort !== false) chat.reasoning_effort = config.upstream.reasoningEffort || "none";
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

function chatToAnthropic(config, chat) {
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
    model: config.upstream.model,
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

  event(type, body) {
    if (!this.res) return;
    writeSse(this.res, type, { type, sequence_number: this.sequence, ...body });
    this.sequence += 1;
  }

  start() {
    if (!this.res) return;
    this.res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    this.event("response.created", { response: this.response() });
    this.event("response.in_progress", { response: this.response() });
  }

  ensureMessage() {
    if (this.message) return this.message;
    this.message = {
      id: `msg_${randomUUID()}`,
      outputIndex: this.nextOutputIndex,
      text: "",
    };
    this.nextOutputIndex += 1;
    this.event("response.output_item.added", {
      output_index: this.message.outputIndex,
      item: { id: this.message.id, type: "message", status: "in_progress", role: "assistant", content: [] },
    });
    this.event("response.content_part.added", {
      item_id: this.message.id,
      output_index: this.message.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    return this.message;
  }

  textDelta(delta) {
    if (!delta) return;
    const message = this.ensureMessage();
    message.text += delta;
    this.event("response.output_text.delta", {
      item_id: message.id,
      output_index: message.outputIndex,
      content_index: 0,
      delta,
    });
  }

  finishMessage() {
    if (!this.message) return;
    const part = { type: "output_text", text: this.message.text, annotations: [] };
    const item = {
      id: this.message.id,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [part],
    };
    this.event("response.output_text.done", {
      item_id: this.message.id,
      output_index: this.message.outputIndex,
      content_index: 0,
      text: this.message.text,
    });
    this.event("response.content_part.done", {
      item_id: this.message.id,
      output_index: this.message.outputIndex,
      content_index: 0,
      part,
    });
    this.event("response.output_item.done", { output_index: this.message.outputIndex, item });
    this.output.push(item);
    this.message = null;
  }

  toolDelta(index, callId, name, argumentsDelta) {
    this.finishMessage();
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
      this.event("response.output_item.added", {
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
        this.event("response.custom_tool_call_input.delta", {
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          delta,
        });
        return;
      }
      this.event("response.function_call_arguments.delta", {
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        delta: argumentsDelta,
      });
    }
  }

  finishTools() {
    for (const index of this.toolOrder) {
      const tool = this.tools.get(index);
      const item = tool.search
        ? { type: "tool_search_call", status: "completed", call_id: tool.callId, execution: "client", arguments: parseToolArguments(tool.arguments) }
        : tool.custom
        ? { id: tool.itemId, type: "custom_tool_call", status: "completed", call_id: tool.callId, name: tool.name, input: toolInputFromArguments(tool.arguments) }
        : { id: tool.itemId, type: "function_call", status: "completed", call_id: tool.callId, name: tool.name, arguments: tool.arguments };
      if (!tool.search) {
        this.event(tool.custom ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done", {
          item_id: tool.itemId,
          output_index: tool.outputIndex,
          [tool.custom ? "input" : "arguments"]: tool.custom ? item.input : tool.arguments,
        });
      }
      this.event("response.output_item.done", { output_index: tool.outputIndex, item });
      this.output.push(item);
    }
    this.tools.clear();
    this.toolOrder = [];
  }

  complete(usage) {
    this.finishMessage();
    this.finishTools();
    const response = this.response("completed", responseUsage(usage));
    if (this.res) {
      this.event("response.completed", { response });
      this.res.write("data: [DONE]\n\n");
      this.res.end();
    }
    return response;
  }
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

async function eachSseData(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = event.split(/\r?\n/).filter((line) => line.startsWith("data:"));
      if (lines.length) onData(lines.map((line) => line.slice(5).trimStart()).join("\n"));
    }
  }
}

async function handleChat(config, payload, res) {
  const upstreamPayload = { ...payload, model: config.upstream.model };
  const upstream = await fetchUpstream(config, upstreamPayload);
  if (!upstream.ok) {
    await upstream.text();
    sendJson(res, upstream.status, { error: { message: `Upstream HTTP ${upstream.status}.`, type: "upstream_error" } });
    return;
  }
  if (!payload.stream) {
    sendJson(res, upstream.status, await upstream.json());
    return;
  }
  res.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

async function handleResponses(config, payload, res) {
  const chatPayload = responsesToChatPayload(config, payload);
  debug(
    `chat payload messages=${chatPayload.messages.map((m) => `${m.role}:${String(m.content || "").length}`).join(",")} tools=${chatPayload.tools?.length || 0}`,
  );
  const upstream = await fetchUpstream(config, chatPayload);
  if (!upstream.ok) {
    await upstream.text();
    sendJson(res, upstream.status, { error: { message: `Upstream HTTP ${upstream.status}.`, type: "upstream_error" } });
    return;
  }

  const writer = new ResponsesWriter(config.upstream.model, payload.stream ? res : null, customToolNames(payload.tools), toolSearchNames(payload.tools));
  writer.start();
  let usage = null;
  const contentType = upstream.headers.get("content-type") || "";

  if (contentType.includes("text/event-stream")) {
    await eachSseData(upstream.body, (data) => {
      if (data === "[DONE]") return;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      usage = chunk.usage || usage;
      for (const choice of chunk.choices || []) {
        const delta = choice.delta || {};
        if (delta.content) writer.textDelta(delta.content);
        for (const call of delta.tool_calls || []) {
          const fn = call.function || {};
          writer.toolDelta(call.index || 0, call.id, fn.name, fn.arguments || "");
        }
      }
    });
  } else {
    const data = await upstream.json();
    usage = data.usage || usage;
    const message = data.choices?.[0]?.message || {};
    if (message.content) writer.textDelta(message.content);
    for (const [index, call] of (message.tool_calls || []).entries()) {
      const fn = call.function || {};
      writer.toolDelta(index, call.id, fn.name, fn.arguments || "");
    }
  }

  const response = writer.complete(usage);
  debug(`responses converted output=${response.output.length} text=${response.output_text.length}`);
  if (!payload.stream) sendJson(res, 200, response);
}

async function handleAnthropicMessages(config, payload, res) {
  const chat = await fetchUpstreamJson(config, anthropicToChatPayload(config, payload));
  const message = chatToAnthropic(config, chat);
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

function loadCodexModelTemplate(home = os.homedir()) {
  const cachePath = path.join(home, ".codex", "models_cache.json");
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const models = Array.isArray(cache.models) ? cache.models : [];
    return models.find((model) => model.shell_type === "shell_command") || null;
  } catch {
    return null;
  }
}

function codexCatalogModel(config, home = os.homedir()) {
  const contextWindow = Number(config.upstream.contextWindow || config.upstream.context_window || 128000);
  const displayName = config.upstream.displayName || config.upstream.name || config.upstream.model;
  const inputModalities = Array.isArray(config.upstream.inputModalities)
    ? config.upstream.inputModalities
    : Array.isArray(config.upstream.input_modalities)
      ? config.upstream.input_modalities
      : ["text"];
  const template = loadCodexModelTemplate(home);
  const model = template ? JSON.parse(JSON.stringify(template)) : {
    slug: config.upstream.model,
    display_name: displayName,
    description: `${displayName} through LLM Coding Bridge.`,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses" },
      { effort: "medium", description: "Balanced reasoning" },
      { effort: "high", description: "Deeper reasoning" },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    base_instructions: "You are Codex, a coding agent. Follow the user's instructions, use concise engineering prose, and avoid exposing secrets.",
    model_messages: {
      instructions_template:
        "{{ personality }}\n\nYou are Codex, a coding agent. Follow the user's instructions, use concise engineering prose, and avoid exposing secrets.",
      instructions_variables: {
        personality_default: "",
        personality_pragmatic: "Use direct, practical engineering prose. Keep updates concise and action-oriented.",
      },
    },
    additional_speed_tiers: [],
    service_tiers: [],
    upgrade: null,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
  };
  model.slug = config.upstream.model;
  model.display_name = displayName;
  model.description = `${displayName} through LLM Coding Bridge.`;
  model.context_window = contextWindow;
  model.max_context_window = contextWindow;
  model.input_modalities = inputModalities;
  model.supports_image_detail_original = inputModalities.includes("image");
  model.priority = 1;
  return model;
}

function startServer(config) {
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || "/", `http://${config.server.host}:${config.server.port}`).pathname;
      if (req.method === "GET" && pathname === "/health") {
        debug("GET /health");
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && pathname === "/v1/models") {
        debug("GET /v1/models");
        const model = { id: config.upstream.model, object: "model", created: 0, owned_by: config.upstream.name || "upstream" };
        sendJson(res, 200, {
          object: "list",
          data: [model],
          models: [codexCatalogModel(config)],
        });
        return;
      }
      if (req.method === "POST" && pathname === "/v1/chat/completions") {
        debug("POST /v1/chat/completions");
        await handleChat(config, await readJson(req), res);
        return;
      }
      if (req.method === "POST" && (pathname === "/v1/responses" || pathname === "/v1/responses/compact")) {
        const payload = await readJson(req);
        const input = Array.isArray(payload.input) ? payload.input.length : typeof payload.input;
        debug(`POST ${pathname} stream=${payload.stream === true} input=${input}`);
        await handleResponses(config, payload, res);
        return;
      }
      if (req.method === "POST" && pathname === "/v1/messages") {
        debug("POST /v1/messages");
        await handleAnthropicMessages(config, await readJson(req), res);
        return;
      }
      if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
        debug("POST /v1/messages/count_tokens");
        handleAnthropicTokenCount(await readJson(req), res);
        return;
      }
      sendJson(res, 404, { error: { message: `Not found: ${req.method} ${req.url}`, type: "not_found" } });
    } catch {
      sendJson(res, 500, { error: { message: "Bridge request failed.", type: "bridge_error" } });
    }
  });

  server.listen(config.server.port, config.server.host, () => {
    console.error(`LLM Coding Bridge listening on http://${config.server.host}:${config.server.port}/v1`);
  });
  return server;
}

async function doctor(config, deep = false, tools = false) {
  const chat = await fetchUpstreamJson(config, {
    model: config.upstream.model,
    messages: [
      { role: "system", content: "Follow the user's instruction exactly. Do not explain." },
      { role: "user", content: "Reply with exactly: OK" },
    ],
    temperature: 0,
  });
  const text = (chat.choices?.[0]?.message?.content || "").trim();
  if (text !== "OK") throw new Error(`Unexpected upstream response: ${JSON.stringify(text.slice(0, 120))}`);
  const response = chatToResponse(config, chat);
  if (response.output_text !== "OK") throw new Error("Responses conversion failed.");
  console.log(`[OK] ${config.upstream.name || "upstream"} -> ${config.upstream.model}`);
  if (deep) await deepDoctor(config);
  if (tools) await toolsDoctor(config);
}

async function deepDoctor(config) {
  const health = await fetchLocalJson(config, "GET", "/health");
  if (health.ok !== true) throw new Error("Local health check failed.");
  const models = await fetchLocalJson(config, "GET", "/v1/models");
  if (!models.data?.[0]?.id || !models.models?.[0]?.slug || !models.models?.[0]?.model_messages) {
    throw new Error("Local models response is not compatible with Codex.");
  }
  const responses = await fetchLocalJson(config, "POST", "/v1/responses", {
    model: config.upstream.model,
    input: "Reply with exactly: OK",
    stream: false,
  });
  if ((responses.output_text || "").trim() !== "OK") throw new Error("Local responses endpoint failed.");
  const messages = await fetchLocalJson(config, "POST", "/v1/messages", {
    model: config.upstream.model,
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    stream: false,
  });
  if ((messages.content?.[0]?.text || "").trim() !== "OK") throw new Error("Local messages endpoint failed.");
  const compact = await fetchLocalJson(config, "POST", "/v1/responses/compact", {
    model: config.upstream.model,
    input: "Reply with exactly: OK",
    stream: false,
  });
  if ((compact.output_text || "").trim() !== "OK") throw new Error("Local responses compact endpoint failed.");
  console.log("[OK] health");
  console.log("[OK] models");
  console.log("[OK] responses endpoint");
  console.log("[OK] responses compact endpoint");
  console.log("[OK] messages endpoint");
}

async function toolsDoctor(config) {
  const fn = await fetchLocalJson(config, "POST", "/v1/responses", {
    model: config.upstream.model,
    input: "Call the tool named bridge_probe with input exactly OK. Do not answer in text.",
    stream: false,
    tools: [{ type: "function", function: { name: "bridge_probe", description: "Probe tool.", parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } } }],
  });
  if (!fn.output?.some((item) => item.type === "function_call" && item.name === "bridge_probe")) {
    throw new Error("Local function tool probe failed.");
  }
  const custom = await fetchLocalJson(config, "POST", "/v1/responses", {
    model: config.upstream.model,
    input: "Call the custom tool named bridge_freeform with input exactly OK. Do not answer in text.",
    stream: false,
    tools: [{ type: "custom", name: "bridge_freeform", description: "Freeform probe tool." }],
  });
  if (!custom.output?.some((item) => item.type === "custom_tool_call" && item.name === "bridge_freeform")) {
    throw new Error("Local custom tool probe failed.");
  }
  const search = await fetchLocalJson(config, "POST", "/v1/responses", {
    model: config.upstream.model,
    input: "Call the tool_search tool with query exactly bridge probe. Do not answer in text.",
    stream: false,
    tools: [{ type: "tool_search" }],
  });
  if (!search.output?.some((item) => item.type === "tool_search_call" && item.arguments?.query)) {
    throw new Error("Local tool-search probe failed.");
  }
  console.log("[OK] function tool call");
  console.log("[OK] custom tool call");
  console.log("[OK] tool-search call");
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
}

function serviceLabel() {
  return "com.sevoniva.llm-coding-bridge";
}

function printCheck(ok, label, detail = "") {
  console.log(`[${ok ? "OK" : "FAIL"}] ${label}${detail ? ` ${detail}` : ""}`);
  return ok;
}

async function status(config) {
  let ok = true;
  printCheck(true, "package", `@sevoniva/llm-coding-bridge ${packageVersion()}`);
  printCheck(true, "config", config.path);
  try {
    const health = await fetchLocalJson(config, "GET", "/health");
    ok = printCheck(health.ok === true, "health", localUrl(config, "/health")) && ok;
  } catch (error) {
    ok = printCheck(false, "health", error.message) && ok;
  }
  try {
    const models = await fetchLocalJson(config, "GET", "/v1/models");
    const model = models.data?.[0]?.id;
    const catalog = models.models?.[0];
    ok = printCheck(Boolean(model && catalog?.slug && catalog?.model_messages), "models", model || "missing") && ok;
  } catch (error) {
    ok = printCheck(false, "models", error.message) && ok;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${serviceLabel()}`], { encoding: "utf8" });
    console.log(`[${result.status === 0 ? "OK" : "WARN"}] launchd ${serviceLabel()}`);
  }
  console.log(`logs ${path.join(os.homedir(), ".llm-coding-bridge", "logs")}`);
  if (!ok) process.exitCode = 1;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function writeChecked(file, text, force) {
  if (!force && fs.existsSync(file)) throw new Error(`${file} already exists. Re-run with --force to overwrite.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function createCodexProfile(config, name, home, force) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Profile name may only contain letters, numbers, dots, dashes, and underscores.");
  const root = path.resolve(home);
  const profilePath = path.join(root, ".codex", `${name}.config.toml`);
  const catalogPath = path.join(root, ".llm-coding-bridge", "codex-model-catalog.json");
  if (!force) {
    for (const file of [profilePath, catalogPath]) {
      if (fs.existsSync(file)) throw new Error(`${file} already exists. Re-run with --force to overwrite.`);
    }
  }
  const baseUrl = `${localUrl(config, "/v1")}`;
  const profile = `model = ${tomlString(config.upstream.model)}
model_provider = "llm-coding-bridge"
model_reasoning_effort = "none"
disable_response_storage = true
model_catalog_json = ${tomlString(catalogPath)}

[model_providers.llm-coding-bridge]
name = "LLM Coding Bridge"
base_url = ${tomlString(baseUrl)}
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
`;
  writeChecked(catalogPath, `${JSON.stringify({ models: [codexCatalogModel(config)] }, null, 2)}\n`, force);
  writeChecked(profilePath, profile, force);
  console.log(`[OK] wrote ${profilePath}`);
  console.log(`[OK] wrote ${catalogPath}`);
  console.log(`Use: codex --profile ${name}`);
}

function printLogs(home, lines) {
  const count = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 80;
  const dir = path.join(path.resolve(home), ".llm-coding-bridge", "logs");
  for (const name of ["out.log", "err.log"]) {
    const file = path.join(dir, name);
    console.log(`==> ${file} <==`);
    if (!fs.existsSync(file)) {
      console.log("(missing)");
      continue;
    }
    const text = fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/).slice(-count).join("\n");
    if (text) console.log(text);
  }
}

function valueOrDefault(value, fallback) {
  const trimmed = String(value || "").trim();
  return trimmed || fallback;
}

async function initConfig(out, runDoctor) {
  const prompt = createPrompt();
  try {
    console.log("LLM Coding Bridge setup / LLM Coding Bridge 配置向导");
    console.log("API keys are read from environment variables or commands and are not written to config files.");
    console.log("API Key 通过环境变量或命令读取，不写入配置文件。\n");
    const host = valueOrDefault(await prompt.ask("Listen host / 本地监听地址 [127.0.0.1]: "), "127.0.0.1");
    const port = Number(valueOrDefault(await prompt.ask("Listen port / 本地监听端口 [18080]: "), "18080"));
    const name = valueOrDefault(await prompt.ask("Provider name / 上游服务名称 [Custom Provider]: "), "Custom Provider");
    const baseUrl = valueOrDefault(await prompt.ask("Upstream base URL / 上游 Base URL: "), "");
    const model = valueOrDefault(await prompt.ask("Upstream model / 上游模型名称: "), "");
    const apiKeyEnv = valueOrDefault(await prompt.ask("API key environment variable / API Key 环境变量 [LLM_API_KEY]: "), "LLM_API_KEY");
    const apiKeyCommand = valueOrDefault(await prompt.ask("API key command (optional) / API Key 读取命令（可选）: "), "");
    const temperature = Number(valueOrDefault(await prompt.ask("Temperature / 采样温度 [0]: "), "0"));
    if (!baseUrl) throw new Error("Upstream base URL is required.");
    if (!model) throw new Error("Upstream model is required.");
    if (!Number.isFinite(port)) throw new Error("Port must be a number.");
    if (!Number.isFinite(temperature)) throw new Error("Temperature must be a number.");

    const config = {
      server: { host, port },
      upstream: { name, baseUrl, model, apiKeyEnv, temperature },
    };
    if (apiKeyCommand) config.upstream.apiKeyCommand = apiKeyCommand;

    const file = path.resolve(out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`\nWrote config: ${file}`);
    console.log(`配置已写入：${file}`);
    console.log("Set the configured environment variable before starting.");
    console.log("启动前设置配置中的环境变量。");
    if (runDoctor !== false) await doctor(loadConfig(file));
  } finally {
    prompt.close();
  }
}

function createPrompt() {
  if (!process.stdin.isTTY) {
    const lines = fs.readFileSync(0, "utf8").split(/\r?\n/);
    return {
      ask(question) {
        process.stdout.write(question);
        return Promise.resolve(lines.shift() || "");
      },
      close() {},
    };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question) {
      return rl.question(question);
    },
    close() {
      rl.close();
    },
  };
}

function printTemplate(name) {
  let file = "codex.config.toml";
  if (name === "claude" || name === "claude-code") file = "claude-code.env";
  if (name === "codex-desktop") file = "codex-desktop.config.toml";
  process.stdout.write(fs.readFileSync(path.join(__dirname, "..", "templates", file), "utf8"));
}

function plistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.sevoniva.llm-coding-bridge.plist");
}

function plistEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function servicePath() {
  return [...new Set([path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
}

function installService(configPath, verb = "installed") {
  if (process.platform !== "darwin") throw new Error("install-service currently supports macOS launchd only.");
  const config = path.resolve(configPath);
  const logDir = path.join(os.homedir(), ".llm-coding-bridge", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${serviceLabel()}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${plistEscape(servicePath())}</string>
  </dict>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string><string>node</string><string>${plistEscape(__filename)}</string><string>serve</string><string>--config</string><string>${plistEscape(config)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${plistEscape(path.join(logDir, "out.log"))}</string>
  <key>StandardErrorPath</key><string>${plistEscape(path.join(logDir, "err.log"))}</string>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), plist);
  const domain = `gui/${process.getuid()}`;
  spawnSync("launchctl", ["bootout", domain, plistPath()], { stdio: "ignore" });
  const result = spawnSync("launchctl", ["bootstrap", domain, plistPath()], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "launchctl bootstrap failed");
  console.log(`[OK] ${verb} ${plistPath()}`);
}

function restartService(configPath) {
  installService(configPath, "restarted");
}

function uninstallService() {
  if (process.platform !== "darwin") throw new Error("uninstall-service currently supports macOS launchd only.");
  const domain = `gui/${process.getuid()}`;
  spawnSync("launchctl", ["bootout", domain, plistPath()], { stdio: "ignore" });
  fs.rmSync(plistPath(), { force: true });
  console.log(`[OK] removed ${plistPath()}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === "help") {
    console.log(usage());
    return;
  }
  if (args.command === "template") return printTemplate(args.template || "codex");
  if (args.command === "init") return initConfig(args.out, args.doctor);
  if (args.command === "doctor") return doctor(loadConfig(args.config), args.deep, args.tools);
  if (args.command === "status") return status(loadConfig(args.config));
  if (args.command === "codex-profile") return createCodexProfile(loadConfig(args.config), args.name, args.home, args.force);
  if (args.command === "logs") return printLogs(args.home, args.lines);
  if (args.command === "serve") return startServer(loadConfig(args.config));
  if (args.command === "install-service") return installService(args.config);
  if (args.command === "restart-service") return restartService(args.config);
  if (args.command === "uninstall-service") return uninstallService();
  throw new Error(`Unknown command: ${args.command}`);
}

main().catch(() => {
  console.error("Command failed.");
  process.exitCode = 1;
});
