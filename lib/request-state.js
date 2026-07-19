"use strict";

const { BridgeError } = require("./bridge-error");
const { types } = require("node:util");

const SAFE_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

const TRANSITIONS = Object.freeze({
  accepted: new Set(["connecting", "failed", "cancelled"]),
  connecting: new Set(["waiting_first_content", "failed", "cancelled"]),
  waiting_first_content: new Set(["failed", "cancelled"]),
  streaming: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function hasSemanticContent(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.choices)) return false;
  for (const choice of value.choices) {
    const delta = choice?.delta;
    if (!delta || typeof delta !== "object") continue;
    if (["content", "reasoning_content", "reasoning", "refusal"].some((key) => isNonEmptyString(delta[key]))) return true;
    if (!Array.isArray(delta.tool_calls)) continue;
    for (const toolCall of delta.tool_calls) {
      const functionData = toolCall?.function;
      if (functionData && typeof functionData === "object" && (isNonEmptyString(functionData.name) || isNonEmptyString(functionData.arguments))) return true;
    }
  }
  return false;
}

function localConfigError(code, phase = "accepted", attempt) {
  return new BridgeError({
    category: "local_config",
    phase,
    retryable: false,
    scope: "local_process",
    code,
    attempt,
  });
}

function isSafeModel(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 160 && !CONTROL_CHARACTER.test(value);
}

function safeOptions(options) {
  if (!options || typeof options !== "object") throw localConfigError("INVALID_REQUEST_STATE_OPTIONS");
  if (types.isProxy(options)) throw localConfigError("INVALID_REQUEST_STATE_OPTIONS");
  try {
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== Object.prototype && prototype !== null) throw localConfigError("INVALID_REQUEST_STATE_OPTIONS");
    const read = (key, validator) => {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor) return undefined;
      if (!Object.hasOwn(descriptor, "value") || !validator(descriptor.value)) throw localConfigError("INVALID_REQUEST_STATE_OPTIONS");
      return descriptor.value;
    };
    return { requestId: read("requestId", (value) => typeof value === "string" && SAFE_REQUEST_ID.test(value)), model: read("model", isSafeModel) };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw localConfigError("INVALID_REQUEST_STATE_OPTIONS");
  }
}

function createRequestState(options = {}) {
  const { requestId, model } = safeOptions(options);
  let phase = "accepted";
  let attempt = 0;
  let heartbeatCount = 0;
  let semanticContentStarted = false;

  function invalidTransition() {
    return localConfigError("INVALID_REQUEST_STATE_TRANSITION", phase, attempt);
  }

  function nextCounter(value) {
    if (value >= Number.MAX_SAFE_INTEGER) throw localConfigError("REQUEST_STATE_COUNTER_OVERFLOW", phase, attempt);
    return value + 1;
  }

  return Object.freeze({
    get requestId() { return requestId; },
    get model() { return model; },
    get phase() { return phase; },
    get attempt() { return attempt; },
    get heartbeatCount() { return heartbeatCount; },
    get semanticContentStarted() { return semanticContentStarted; },
    transition(nextPhase) {
      if (!TRANSITIONS[phase].has(nextPhase)) throw invalidTransition();
      phase = nextPhase;
      return phase;
    },
    nextAttempt() {
      attempt = nextCounter(attempt);
      return attempt;
    },
    recordHeartbeat() {
      heartbeatCount = nextCounter(heartbeatCount);
      return heartbeatCount;
    },
    observeChatData(data) {
      if (phase !== "waiting_first_content" && phase !== "streaming") return false;
      if (typeof data !== "string") return false;
      if (data === "[DONE]") return false;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        return false;
      }
      if (!hasSemanticContent(parsed)) return false;
      if (!semanticContentStarted) semanticContentStarted = true;
      if (phase === "waiting_first_content") phase = "streaming";
      return true;
    },
  });
}

module.exports = { createRequestState };
