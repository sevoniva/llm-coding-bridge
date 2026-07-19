"use strict";

const { BridgeError } = require("./bridge-error");

const TRANSITIONS = Object.freeze({
  accepted: new Set(["connecting", "failed", "cancelled"]),
  connecting: new Set(["waiting_first_content", "failed", "cancelled"]),
  waiting_first_content: new Set(["streaming", "failed", "cancelled"]),
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

function createRequestState({ requestId, model } = {}) {
  let phase = "accepted";
  let attempt = 0;
  let heartbeatCount = 0;
  let semanticContentStarted = false;

  function invalidTransition() {
    return new BridgeError({
      category: "local_config",
      phase,
      retryable: false,
      scope: "local_process",
      code: "INVALID_REQUEST_STATE_TRANSITION",
      requestId,
      model,
      attempt,
    });
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
      attempt += 1;
      return attempt;
    },
    recordHeartbeat() {
      heartbeatCount += 1;
      return heartbeatCount;
    },
    observeChatData(data) {
      if (phase !== "waiting_first_content" && phase !== "streaming") return false;
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
