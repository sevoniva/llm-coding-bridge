"use strict";

function requireTimeout(value, allowZero, name) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be a safe integer.`);
  return value;
}

function timeoutError(phase) {
  const error = new Error(`Upstream ${phase} phase timed out.`);
  error.name = "AbortError";
  error.code = "UPSTREAM_TIMEOUT";
  error.phase = phase;
  return error;
}

function createPhaseDeadline({ controller, policy, streaming, timers = {} }) {
  if (!controller || typeof controller.abort !== "function" || !controller.signal) {
    throw new TypeError("controller must be an AbortController.");
  }
  if (!policy || typeof policy !== "object") throw new TypeError("policy must be an object.");
  const timeouts = {
    headers: requireTimeout(policy.headerTimeoutMs, false, "policy.headerTimeoutMs"),
    first_data: requireTimeout(policy.firstDataTimeoutMs, false, "policy.firstDataTimeoutMs"),
    idle: requireTimeout(policy.idleTimeoutMs, false, "policy.idleTimeoutMs"),
    non_stream_total: requireTimeout(policy.nonStreamingTotalTimeoutMs, false, "policy.nonStreamingTotalTimeoutMs"),
    stream_total: requireTimeout(policy.streamingTotalTimeoutMs, true, "policy.streamingTotalTimeoutMs"),
  };
  const setTimer = timers.setTimeout ?? setTimeout;
  const clearTimer = timers.clearTimeout ?? clearTimeout;
  const now = timers.now ?? Date.now;
  if (typeof setTimer !== "function" || typeof clearTimer !== "function" || typeof now !== "function") {
    throw new TypeError("timers must provide setTimeout, clearTimeout, and now functions.");
  }

  let timer = null;
  let startedAt = null;
  let totalDeadline = null;
  let active = !controller.signal.aborted;

  function clear() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function stop() {
    if (!active) return;
    active = false;
    clear();
    controller.signal.removeEventListener("abort", stop);
  }

  function arm(phase, durationMs) {
    if (!active) return;
    const current = now();
    if (!Number.isSafeInteger(current) || current < 0) throw new TypeError("timers.now must return a safe integer.");
    let due = current + durationMs;
    let timeoutPhase = phase;
    if (totalDeadline !== null && totalDeadline <= due) {
      due = totalDeadline;
      timeoutPhase = "total";
    }
    clear();
    timer = setTimer(() => {
      if (!active) return;
      active = false;
      timer = null;
      controller.signal.removeEventListener("abort", stop);
      controller.abort(timeoutError(timeoutPhase));
    }, Math.max(0, due - current));
  }

  function waitingForHeaders() {
    if (!active) return;
    const current = now();
    if (!Number.isSafeInteger(current) || current < 0) throw new TypeError("timers.now must return a safe integer.");
    if (startedAt === null) {
      startedAt = current;
      const totalTimeoutMs = streaming ? timeouts.stream_total : timeouts.non_stream_total;
      totalDeadline = totalTimeoutMs === 0 ? null : startedAt + totalTimeoutMs;
    }
    arm("headers", timeouts.headers);
  }

  function headersReceived() {
    if (!active) return;
    if (streaming) arm("first_data", timeouts.first_data);
    else arm("total", Math.max(0, totalDeadline - now()));
  }

  function dataReceived() {
    if (!active || !streaming) return;
    arm("idle", timeouts.idle);
  }

  controller.signal.addEventListener("abort", stop, { once: true });
  return Object.freeze({
    waitingForHeaders,
    headersReceived,
    dataReceived,
    completed: stop,
    cancelled: stop,
  });
}

module.exports = { createPhaseDeadline };
