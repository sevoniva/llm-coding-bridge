"use strict";

const assert = require("node:assert/strict");
const { BridgeError } = require("../lib/bridge-error");
const { createRequestState } = require("../lib/request-state");

function chatData(delta) {
  return JSON.stringify({ choices: [{ delta }] });
}

function waitingState() {
  const state = createRequestState({ requestId: "req-1", model: "coding-fast", now: () => 1000 });
  state.transition("connecting");
  state.transition("waiting_first_content");
  return state;
}

function testInitialStateAndNormalSuccessPath() {
  const state = createRequestState({ requestId: "req-1", model: "coding-fast", now: () => 1000 });
  assert.equal(state.phase, "accepted");
  assert.equal(state.semanticContentStarted, false);
  assert.equal(state.requestId, "req-1");
  assert.equal(state.model, "coding-fast");
  state.transition("connecting");
  state.transition("waiting_first_content");
  state.transition("streaming");
  state.transition("completed");
  assert.equal(state.phase, "completed");
}

function testTerminalExitsAndIllegalTransitions() {
  for (const phase of ["accepted", "connecting", "waiting_first_content", "streaming"]) {
    for (const terminal of ["failed", "cancelled"]) {
      const state = createRequestState({ requestId: "req-1", model: "coding-fast" });
      while (state.phase !== phase) {
        state.transition({ accepted: "connecting", connecting: "waiting_first_content", waiting_first_content: "streaming" }[state.phase]);
      }
      state.transition(terminal);
      assert.equal(state.phase, terminal, `${phase} -> ${terminal}`);
    }
  }

  const state = waitingState();
  for (const target of ["accepted", "waiting_first_content", "completed"]) {
    assert.throws(() => state.transition(target), BridgeError, `waiting_first_content -> ${target}`);
  }
  state.transition("failed");
  assert.throws(() => state.transition("cancelled"), BridgeError);
  const cancelled = createRequestState({ requestId: "req-1", model: "coding-fast" });
  cancelled.transition("cancelled");
  assert.throws(() => cancelled.transition("failed"), BridgeError);
  const completed = waitingState();
  completed.transition("streaming");
  completed.transition("completed");
  assert.throws(() => completed.transition("failed"), BridgeError);

  const maliciousTarget = `streaming-secret-${"x".repeat(200)}`;
  let error;
  assert.throws(() => state.transition(maliciousTarget), (caught) => {
    error = caught;
    return caught instanceof BridgeError && caught.category === "local_config" && caught.code === "INVALID_REQUEST_STATE_TRANSITION";
  });
  assert.doesNotMatch(JSON.stringify(error), /streaming-secret|x{20}/);
}

function testAttemptsAndHeartbeatsAreMonotonic() {
  const state = createRequestState({ requestId: "req-1", model: "coding-fast" });
  assert.equal(state.nextAttempt(), 1);
  assert.equal(state.nextAttempt(), 2);
  assert.equal(state.attempt, 2);
  assert.equal(state.recordHeartbeat(), 1);
  assert.equal(state.recordHeartbeat(), 2);
  assert.equal(state.heartbeatCount, 2);
}

function testNonSemanticChatDataDoesNotStartStreaming() {
  const state = waitingState();
  state.recordHeartbeat();
  for (const data of [
    "[DONE]",
    JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } }),
    chatData({ role: "assistant" }),
    "{",
  ]) {
    assert.equal(state.observeChatData(data), false, data);
    assert.equal(state.semanticContentStarted, false, data);
    assert.equal(state.phase, "waiting_first_content", data);
  }
  assert.equal(state.heartbeatCount, 1);
}

function testSemanticChatDataStartsStreaming() {
  const cases = [
    ["content", { content: "answer" }],
    ["reasoning_content", { reasoning_content: "plan" }],
    ["reasoning", { reasoning: "plan" }],
    ["refusal", { refusal: "cannot comply" }],
    ["tool-call name", { tool_calls: [{ function: { name: "lookup" } }] }],
    ["tool-call arguments fragment", { tool_calls: [{ function: { arguments: "{\"q\":" } }] }],
  ];
  for (const [name, delta] of cases) {
    const state = waitingState();
    assert.equal(state.observeChatData(chatData(delta)), true, name);
    assert.equal(state.semanticContentStarted, true, name);
    assert.equal(state.phase, "streaming", name);
    assert.equal(state.observeChatData(chatData({ content: "later" })), true, name);
    assert.equal(state.phase, "streaming", name);
  }
}

function testOnlyNonEmptySemanticStringsCount() {
  const state = waitingState();
  assert.equal(state.observeChatData(chatData({
    content: "",
    reasoning_content: "",
    reasoning: "",
    refusal: "",
    tool_calls: [{ function: { name: "", arguments: "" } }],
  })), false);
  assert.equal(state.semanticContentStarted, false);
  assert.equal(state.observeChatData(chatData({ content: " " })), true);
  assert.equal(state.phase, "streaming");
}

function testChatDataCannotMutateInactiveOrTerminalState() {
  const state = createRequestState({ requestId: "req-1", model: "coding-fast" });
  assert.equal(state.observeChatData(chatData({ content: "early" })), false);
  assert.equal(state.semanticContentStarted, false);
  state.transition("failed");
  assert.equal(state.observeChatData(chatData({ content: "late" })), false);
  assert.equal(state.semanticContentStarted, false);
}

testInitialStateAndNormalSuccessPath();
testTerminalExitsAndIllegalTransitions();
testAttemptsAndHeartbeatsAreMonotonic();
testNonSemanticChatDataDoesNotStartStreaming();
testSemanticChatDataStartsStreaming();
testOnlyNonEmptySemanticStringsCount();
testChatDataCannotMutateInactiveOrTerminalState();
console.log("request-state tests passed");
