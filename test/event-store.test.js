"use strict";

const assert = require("node:assert/strict");
const { createEventStore } = require("../lib/event-store");

function testRingKeepsNewestEventsWithMonotonicSequence() {
  const store = createEventStore({ capacity: 3, now: () => 1700000000000 });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    store.append({ type: "request", phase: "attempt", requestId: "req-safe", attempt });
  }
  assert.deepEqual(store.snapshot().map((event) => event.sequence), [3, 4, 5]);
}

function testEventsAreImmutableCopies() {
  const store = createEventStore({ now: () => 1700000000000 });
  const event = { type: "request", phase: "start", requestId: "req-safe" };
  const appended = store.append(event);
  event.requestId = "mutated";
  assert.ok(Object.isFrozen(appended));
  assert.equal(store.snapshot()[0].requestId, "req-safe");
  const snapshot = store.snapshot();
  snapshot[0].requestId = "mutated-again";
  assert.equal(store.snapshot()[0].requestId, "req-safe");
}

function testRedactsUntrustedInputWithoutAccessingGettersOrProxies() {
  const store = createEventStore({ now: () => 1700000000000 });
  let getterCalled = false;
  const event = {
    type: "request",
    phase: "failure",
    requestId: "req-safe",
    prompt: "private prompt",
    response: "private response",
    headers: { authorization: "Bearer secret-token" },
    authorization: "Bearer secret-token",
    body: "private body",
    reasoning: "private reasoning",
    toolArguments: "private arguments",
    error: new Error("private error"),
    cause: new Error("private cause"),
    message: "private message",
    credentials: "private credentials",
    key: "private key",
    unknown: "private unknown",
  };
  Object.defineProperty(event, "model", {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error("getter must not run");
    },
  });
  const appended = store.append(event);
  assert.equal(getterCalled, false);
  const serialized = JSON.stringify(appended);
  assert.doesNotMatch(serialized, /prompt|response|headers|authorization|body|reasoning|toolArguments|error|cause|message|credentials|unknown|private|secret-token/i);

  const proxy = new Proxy({}, { ownKeys() { throw new Error("proxy trap must not run"); } });
  const proxyRecord = store.append(proxy);
  assert.deepEqual(Object.keys(proxyRecord).sort(), ["sequence", "timestamp"]);
}

function testSnapshotsUseValidatedMonotonicCursorAndLimits() {
  const store = createEventStore({ capacity: 5, now: () => 1700000000000 });
  store.append({ type: "request", phase: "start" });
  store.append({ type: "request", phase: "complete" });
  assert.deepEqual(store.snapshot({ afterSequence: 1, limit: 1 }).map((event) => event.sequence), [2]);
  assert.deepEqual(store.snapshot({ afterSequence: -1 }), []);
  assert.deepEqual(store.snapshot({ limit: 0 }), []);
  assert.deepEqual(store.snapshot({ limit: 99 }).map((event) => event.sequence), [1, 2]);
}

testRingKeepsNewestEventsWithMonotonicSequence();
testEventsAreImmutableCopies();
testRedactsUntrustedInputWithoutAccessingGettersOrProxies();
testSnapshotsUseValidatedMonotonicCursorAndLimits();
console.log("event-store tests passed");
