"use strict";

function cancellationError() {
  const error = new Error("Request cancelled while waiting for an upstream slot.");
  error.name = "AbortError";
  error.code = "CLIENT_CANCELLED";
  return error;
}

function createUpstreamConcurrencyRegistry() {
  const entries = new Map();

  function entryFor(key) {
    let entry = entries.get(key);
    if (!entry) {
      entry = { active: 0, waiters: [] };
      entries.set(key, entry);
    }
    return entry;
  }

  function acquire(key, limit, signal) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      return Promise.reject(new TypeError("Upstream concurrency limit must be a non-negative integer."));
    }
    if (signal?.aborted) return Promise.reject(cancellationError());
    if (limit === 0) return Promise.resolve({ queued: false, release() {} });

    const entry = entryFor(key);
    const createLease = (queued) => {
      let released = false;
      return {
        queued,
        release() {
          if (released) return;
          released = true;
          const waiter = entry.waiters.shift();
          if (waiter) {
            waiter.detach();
            waiter.resolve(createLease(true));
            return;
          }
          entry.active -= 1;
          if (entry.active === 0) entries.delete(key);
        },
      };
    };

    if (entry.active < limit) {
      entry.active += 1;
      return Promise.resolve(createLease(false));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        detach() {
          signal?.removeEventListener("abort", abort);
        },
      };
      function abort() {
        const index = entry.waiters.indexOf(waiter);
        if (index >= 0) entry.waiters.splice(index, 1);
        waiter.detach();
        reject(cancellationError());
      }
      entry.waiters.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  return Object.freeze({ acquire });
}

function waitWithSignal(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(cancellationError());
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(cancellationError());
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function createUpstreamPacingRegistry(options = {}) {
  const now = options.now || Date.now;
  const wait = options.wait || waitWithSignal;
  const nextStarts = new Map();

  async function waitForTurn(key, intervalMs, signal) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
      throw new TypeError("Upstream request interval must be a non-negative integer.");
    }
    if (signal?.aborted) throw cancellationError();
    if (intervalMs === 0) return Object.freeze({ delayMs: 0 });

    const current = now();
    const scheduled = Math.max(current, nextStarts.get(key) || current);
    nextStarts.set(key, scheduled + intervalMs);
    const delayMs = scheduled - current;
    if (delayMs > 0) await wait(delayMs, signal);
    return Object.freeze({ delayMs });
  }

  return Object.freeze({ wait: waitForTurn });
}

module.exports = { createUpstreamConcurrencyRegistry, createUpstreamPacingRegistry };
