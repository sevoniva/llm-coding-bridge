"use strict";

const METADATA_KEYS = ["id", "created", "model", "system_fingerprint", "service_tier", "usage"];

function protocolError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "UPSTREAM_PROTOCOL_ERROR";
  return error;
}

function sanitizeChatPayload(payload, upstream = {}) {
  const sanitized = { ...payload };
  if (upstream?.stripChatTemplateKwargs !== true) return sanitized;

  delete sanitized.chat_template_kwargs;
  if (payload.extra_body && typeof payload.extra_body === "object" && !Array.isArray(payload.extra_body)) {
    sanitized.extra_body = { ...payload.extra_body };
    delete sanitized.extra_body.chat_template_kwargs;
  }
  return sanitized;
}

function isSseResponse(text, contentType) {
  return String(contentType || "").toLowerCase().includes("text/event-stream")
    || /(?:^|[\r\n])[\t ]*(?:\uFEFF)?data(?::|$)/.test(text);
}

function extractSseDataFrames(text, options = {}) {
  const frames = [];
  let dataLines = [];
  let eventBytes = 0;
  let eventLines = 0;
  const maxSseEventBytes = Number.isSafeInteger(options.maxSseEventBytes) && options.maxSseEventBytes > 0
    ? options.maxSseEventBytes
    : Number.POSITIVE_INFINITY;

  function flush() {
    if (dataLines.length > 0) frames.push(dataLines.join("\n"));
    dataLines = [];
    eventBytes = 0;
    eventLines = 0;
  }

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    if (rawLine.trim() === "") {
      flush();
      continue;
    }

    // Count CRLF for inter-line separators so LF-only input is bounded
    // conservatively and cannot exceed the configured byte budget.
    eventBytes += Buffer.byteLength(rawLine, "utf8") + (eventLines > 0 ? 2 : 0);
    eventLines += 1;
    if (eventBytes > maxSseEventBytes) {
      const error = new Error("Upstream SSE event exceeded the configured limit.");
      error.code = "UPSTREAM_SSE_EVENT_TOO_LARGE";
      throw error;
    }

    const line = rawLine.replace(/^\uFEFF/, "").trimStart();
    if (line === "data") {
      dataLines.push("");
      continue;
    }
    if (!line.startsWith("data:")) continue;

    let value = line.slice(5);
    if (value.startsWith(" ")) value = value.slice(1);
    dataLines.push(value);
  }
  flush();
  return frames;
}

function appendFragment(target, key, value) {
  if (typeof value !== "string") return false;
  target[key] += value;
  return true;
}

function appendStableFragment(target, key, value) {
  if (typeof value !== "string") return false;
  if (!target[key] || value.startsWith(target[key])) target[key] = value;
  else if (target[key] !== value && !target[key].endsWith(value)) target[key] += value;
  return true;
}

function mergeLogprobs(current, incoming) {
  const currentIsObject = current && typeof current === "object" && !Array.isArray(current);
  const incomingIsObject = incoming && typeof incoming === "object" && !Array.isArray(incoming);
  if (!incomingIsObject) return currentIsObject && incoming === null ? current : incoming;
  if (!currentIsObject) return { ...incoming };

  const merged = { ...current, ...incoming };
  for (const key of ["content", "refusal"]) {
    if (Array.isArray(current[key]) && Array.isArray(incoming[key])) {
      merged[key] = [...current[key], ...incoming[key]];
    }
  }
  return merged;
}

function createChoice(index) {
  return {
    index,
    role: "assistant",
    content: "",
    hasContent: false,
    reasoningContent: "",
    hasReasoningContent: false,
    reasoning: "",
    hasReasoning: false,
    refusal: "",
    hasRefusal: false,
    toolCalls: new Map(),
    hasFinishReason: false,
    finishReason: undefined,
    hasLogprobs: false,
    logprobs: undefined,
  };
}

function createToolCall(index) {
  return {
    index,
    id: "",
    hasId: false,
    type: "",
    hasType: false,
    name: "",
    hasName: false,
    arguments: "",
    hasArguments: false,
  };
}

function mergeToolCalls(choice, toolCallDeltas) {
  if (!Array.isArray(toolCallDeltas)) return;

  for (const delta of toolCallDeltas) {
    if (!delta || typeof delta !== "object" || !Number.isInteger(delta.index)) continue;
    let toolCall = choice.toolCalls.get(delta.index);
    if (!toolCall) {
      toolCall = createToolCall(delta.index);
      choice.toolCalls.set(delta.index, toolCall);
    }

    toolCall.hasId = appendStableFragment(toolCall, "id", delta.id) || toolCall.hasId;
    toolCall.hasType = appendStableFragment(toolCall, "type", delta.type) || toolCall.hasType;
    if (delta.function && typeof delta.function === "object") {
      toolCall.hasName = appendStableFragment(toolCall, "name", delta.function.name) || toolCall.hasName;
      toolCall.hasArguments = appendFragment(toolCall, "arguments", delta.function.arguments) || toolCall.hasArguments;
    }
  }
}

function mergeChoice(choice, delta) {
  if (delta.delta && typeof delta.delta === "object") {
    if (typeof delta.delta.role === "string") choice.role = delta.delta.role;
    choice.hasContent = appendFragment(choice, "content", delta.delta.content) || choice.hasContent;
    choice.hasReasoningContent = appendFragment(choice, "reasoningContent", delta.delta.reasoning_content)
      || choice.hasReasoningContent;
    choice.hasReasoning = appendFragment(choice, "reasoning", delta.delta.reasoning) || choice.hasReasoning;
    choice.hasRefusal = appendFragment(choice, "refusal", delta.delta.refusal) || choice.hasRefusal;
    mergeToolCalls(choice, delta.delta.tool_calls);
  }
  if (Object.hasOwn(delta, "finish_reason")) {
    choice.hasFinishReason = true;
    choice.finishReason = delta.finish_reason;
  }
  if (Object.hasOwn(delta, "logprobs")) {
    choice.hasLogprobs = true;
    choice.logprobs = mergeLogprobs(choice.logprobs, delta.logprobs);
  }
}

function materializeToolCall(toolCall) {
  const result = {};
  if (toolCall.hasId) result.id = toolCall.id;
  if (toolCall.hasType) result.type = toolCall.type;
  if (toolCall.hasName || toolCall.hasArguments) {
    result.function = {};
    if (toolCall.hasName) result.function.name = toolCall.name;
    if (toolCall.hasArguments) result.function.arguments = toolCall.arguments;
  }
  return result;
}

function materializeChoice(choice) {
  const toolCalls = [...choice.toolCalls.values()]
    .sort((left, right) => left.index - right.index)
    .map(materializeToolCall);
  const message = {
    role: choice.role || "assistant",
    content: toolCalls.length > 0 && !choice.hasContent ? null : choice.content,
  };
  if (choice.hasReasoningContent) message.reasoning_content = choice.reasoningContent;
  if (choice.hasReasoning) message.reasoning = choice.reasoning;
  if (choice.hasRefusal) message.refusal = choice.refusal;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const result = { index: choice.index, message };
  if (choice.hasFinishReason) result.finish_reason = choice.finishReason;
  if (choice.hasLogprobs) result.logprobs = choice.logprobs;
  return result;
}

function parseSseCompletion(text, options) {
  const metadata = {};
  const choices = new Map();
  let hasCompletionChunk = false;
  let hasTerminalChoice = false;
  let sawDone = false;
  let mode = null;
  let fullCompletion = null;

  for (const data of extractSseDataFrames(text, options)) {
    const frame = data.trim();
    if (!frame) continue;
    if (frame === "[DONE]") {
      sawDone = true;
      continue;
    }

    let chunk;
    try {
      chunk = JSON.parse(frame);
    } catch (cause) {
      throw protocolError(`Invalid SSE data JSON: ${cause.message}`, cause);
    }
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) continue;
    if (chunk.error) throw protocolError("SSE response contained an upstream error.");

    for (const key of METADATA_KEYS) {
      if (Object.hasOwn(chunk, key)) metadata[key] = chunk[key];
    }
    if (!Array.isArray(chunk.choices)) continue;

    const validChoices = chunk.choices.filter((choice) => (
      choice && typeof choice === "object" && Number.isInteger(choice.index)
    ));
    const hasMessages = validChoices.some((choice) => choice.message && typeof choice.message === "object");
    const hasDeltas = validChoices.some((choice) => choice.delta && typeof choice.delta === "object");
    if (hasMessages && hasDeltas) throw protocolError("SSE response mixed full and delta completion choices.");

    if (hasMessages) {
      if (mode === "delta") throw protocolError("SSE response mixed full and delta completion frames.");
      if (fullCompletion) throw protocolError("SSE response contained multiple full completions.");
      mode = "full";
      fullCompletion = { ...chunk, object: "chat.completion" };
      hasCompletionChunk = true;
      hasTerminalChoice = validChoices.some((choice) => choice.finish_reason != null) || hasTerminalChoice;
      continue;
    }

    if (validChoices.length > 0 && !hasDeltas) {
      throw protocolError("SSE response contained an unsupported completion choice.");
    }
    if (hasDeltas && mode === "full") {
      throw protocolError("SSE response mixed full and delta completion frames.");
    }
    if (hasDeltas) mode = "delta";

    for (const delta of validChoices) {
      hasCompletionChunk = true;
      if (delta.finish_reason != null) hasTerminalChoice = true;
      let choice = choices.get(delta.index);
      if (!choice) {
        choice = createChoice(delta.index);
        choices.set(delta.index, choice);
      }
      mergeChoice(choice, delta);
    }
  }

  if (!hasCompletionChunk) throw protocolError("SSE response contained no valid completion chunk.");
  if (!sawDone && !hasTerminalChoice) throw protocolError("SSE response ended before completion.");

  if (fullCompletion) {
    return { ...fullCompletion, ...metadata, object: "chat.completion" };
  }

  return {
    ...metadata,
    object: "chat.completion",
    choices: [...choices.values()]
      .sort((left, right) => left.index - right.index)
      .map(materializeChoice),
  };
}

function parseNonStreamChatResponse(text, contentType = "", options = {}) {
  const body = String(text).replace(/^([ \t\r\n]*)\uFEFF/, "$1");
  const firstCharacter = body.trimStart()[0];
  if (firstCharacter === "{" || firstCharacter === "[") {
    try { return { completion: JSON.parse(body), normalizedSse: false }; } catch (cause) { throw protocolError(cause.message, cause); }
  }
  if (!isSseResponse(body, contentType)) {
    return {
      completion: (() => { try { return JSON.parse(body); } catch (cause) { throw protocolError(cause.message, cause); } })(),
      normalizedSse: false,
    };
  }
  return { completion: parseSseCompletion(body, options), normalizedSse: true };
}

module.exports = { parseNonStreamChatResponse, sanitizeChatPayload };
