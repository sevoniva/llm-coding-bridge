"use strict";

const assert = require("node:assert/strict");
const { createPhaseDeadline } = require("../lib/phase-timeout");

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const jobs = new Map();
  return {
    now: () => now,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      jobs.set(id, { callback, due: now + delayMs });
      return id;
    },
    clearTimeout(id) {
      jobs.delete(id);
    },
    advance(delayMs) {
      const target = now + delayMs;
      while (true) {
        const due = [...jobs.entries()]
          .filter(([, job]) => job.due <= target)
          .sort((left, right) => left[1].due - right[1].due)[0];
        if (!due) break;
        now = due[1].due;
        jobs.delete(due[0]);
        due[1].callback();
      }
      now = target;
    },
    nextDelay() {
      const due = Math.min(...[...jobs.values()].map((job) => job.due));
      return Number.isFinite(due) ? due - now : null;
    },
    get size() {
      return jobs.size;
    },
  };
}

function policy(overrides = {}) {
  return {
    headerTimeoutMs: 100,
    firstDataTimeoutMs: 200,
    idleTimeoutMs: 300,
    nonStreamingTotalTimeoutMs: 500,
    streamingTotalTimeoutMs: 0,
    ...overrides,
  };
}

function deadline({ streaming = true, policy: selectedPolicy = policy() } = {}) {
  const controller = new AbortController();
  const timers = createFakeTimers();
  const value = createPhaseDeadline({ controller, policy: selectedPolicy, streaming, timers });
  return { controller, timers, deadline: value };
}

{
  const current = deadline();
  current.deadline.waitingForHeaders();
  current.timers.advance(99);
  assert.equal(current.controller.signal.aborted, false);
  current.timers.advance(1);
  assert.equal(current.controller.signal.reason.code, "UPSTREAM_TIMEOUT");
  assert.equal(current.controller.signal.reason.phase, "headers");
}

{
  const current = deadline();
  current.deadline.waitingForHeaders();
  current.deadline.headersReceived();
  current.timers.advance(200);
  assert.equal(current.controller.signal.reason.phase, "first_data");
}

{
  const current = deadline();
  current.deadline.waitingForHeaders();
  current.deadline.headersReceived();
  current.deadline.dataReceived();
  current.timers.advance(299);
  current.deadline.dataReceived();
  current.timers.advance(299);
  assert.equal(current.controller.signal.aborted, false);
  current.timers.advance(1);
  assert.equal(current.controller.signal.reason.phase, "idle");
}

{
  const current = deadline({ streaming: false, policy: policy({ headerTimeoutMs: 400, nonStreamingTotalTimeoutMs: 500 }) });
  current.deadline.waitingForHeaders();
  current.timers.advance(300);
  current.deadline.headersReceived();
  assert.equal(current.timers.nextDelay(), 200);
  current.timers.advance(200);
  assert.equal(current.controller.signal.reason.phase, "total");
}

{
  const current = deadline({ policy: policy({ headerTimeoutMs: 100, firstDataTimeoutMs: 100, idleTimeoutMs: 100 }) });
  current.deadline.waitingForHeaders();
  current.deadline.headersReceived();
  for (let count = 0; count < 20; count += 1) {
    current.timers.advance(99);
    current.deadline.dataReceived();
  }
  assert.equal(current.controller.signal.aborted, false);
}

{
  const current = deadline({ policy: policy({ streamingTotalTimeoutMs: 250 }) });
  current.deadline.waitingForHeaders();
  current.deadline.headersReceived();
  current.deadline.dataReceived();
  current.timers.advance(200);
  current.deadline.dataReceived();
  current.timers.advance(50);
  assert.equal(current.controller.signal.reason.phase, "total");
}

for (const finish of ["completed", "cancelled"]) {
  const current = deadline();
  current.deadline.waitingForHeaders();
  current.deadline[finish]();
  assert.equal(current.timers.size, 0);
  current.timers.advance(1000);
  assert.equal(current.controller.signal.aborted, false);
}

for (const reason of [new Error("upstream abort"), new Error("client cancellation")]) {
  const current = deadline();
  current.deadline.waitingForHeaders();
  current.controller.abort(reason);
  assert.equal(current.timers.size, 0);
  current.timers.advance(1000);
  assert.equal(current.controller.signal.reason, reason);
}

{
  const stable = deadline({ policy: policy({
    headerTimeoutMs: 600000,
    firstDataTimeoutMs: 600000,
    idleTimeoutMs: 600000,
  }) });
  stable.deadline.waitingForHeaders();
  assert.equal(stable.timers.nextDelay(), 600000);

  const longThinking = deadline({ policy: policy({
    headerTimeoutMs: 1800000,
    firstDataTimeoutMs: 1800000,
    idleTimeoutMs: 600000,
  }) });
  longThinking.deadline.waitingForHeaders();
  assert.equal(longThinking.timers.nextDelay(), 1800000);
  longThinking.deadline.headersReceived();
  assert.equal(longThinking.timers.nextDelay(), 1800000);
}

console.log("phase timeout tests passed");
