"use strict";

// SSE keepalive helper. The default remains a `: ping\n\n` comment frame, while
// callers that need application-level activity can provide a protocol-specific
// frame. touch() resets the idle deadline after real upstream activity.
//
// The helper uses writeWithBackpressure so it respects downstream backpressure
// and tears down cleanly if the client disconnects or stalls beyond the drain
// timeout. The interval timer is .unref()'d so it does not block process exit
// during graceful shutdown.

const { writeWithBackpressure } = require("./http-util");

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 1000;
const PING_FRAME = ": ping\n\n";

function startHeartbeat(res, intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS, options = {}) {
  const frame = typeof options.frame === "string" && options.frame ? options.frame : PING_FRAME;
  const now = options.now || Date.now;
  const onHeartbeat = typeof options.onHeartbeat === "function" ? options.onHeartbeat : null;
  if (typeof now !== "function") throw new TypeError("options.now must be a function.");
  // Disabled: return a no-op handle so callers can always call .stop().
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { stop() {}, touch() {} };
  }

  let timer = null;
  let writing = false;
  let stopped = false;
  let lastActivityAt = now();

  const touch = () => {
    lastActivityAt = now();
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (res && typeof res.off === "function") {
      res.off("close", stop);
      res.off("error", stop);
    }
  };

  const tick = async () => {
    // Re-entrancy guard: never overlap writes; a slow drain must not cause
    // interleaved partial frames.
    if (writing || stopped || now() - lastActivityAt < intervalMs) return;
    writing = true;
    try {
      const ok = await writeWithBackpressure(res, frame);
      if (!ok) stop();
      else {
        lastActivityAt = now();
        try { onHeartbeat?.(); } catch {}
      }
    } catch {
      stop();
    } finally {
      writing = false;
    }
  };

  // Tear down on close/error so we never schedule writes to a dead socket.
  if (res && typeof res.on === "function") {
    res.on("close", stop);
    res.on("error", stop);
  }
  // If the response is already closed/destroyed, stop immediately.
  if (res && (res.destroyed || res.writableEnded)) {
    stop();
    return { stop, touch };
  }

  timer = setInterval(tick, intervalMs);
  // Do not keep the event loop alive solely for heartbeats.
  if (timer && typeof timer.unref === "function") timer.unref();

  return { stop, touch };
}

module.exports = { startHeartbeat, DEFAULT_HEARTBEAT_INTERVAL_MS };
