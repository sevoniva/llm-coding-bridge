"use strict";

// SSE keepalive helper. Emits `: ping\n\n` comment frames (per the SSE spec,
// a line starting with ":" is a comment and MUST be ignored by parsers) so that
// clients with short idle timeouts (e.g. ZCode subagents) do not cancel the
// request while the upstream is "thinking" before its first byte.
//
// The helper uses writeWithBackpressure so it respects downstream backpressure
// and tears down cleanly if the client disconnects or stalls beyond the drain
// timeout. The interval timer is .unref()'d so it does not block process exit
// during graceful shutdown.

const { writeWithBackpressure } = require("./http-util");

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 1000;
const PING_FRAME = ": ping\n\n";

function startHeartbeat(res, intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS) {
  // Disabled: return a no-op handle so callers can always call .stop().
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { stop() {} };
  }

  let timer = null;
  let writing = false;
  let stopped = false;

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
    if (writing || stopped) return;
    writing = true;
    try {
      const ok = await writeWithBackpressure(res, PING_FRAME);
      if (!ok) stop();
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
    return { stop };
  }

  timer = setInterval(tick, intervalMs);
  // Do not keep the event loop alive solely for heartbeats.
  if (timer && typeof timer.unref === "function") timer.unref();

  return { stop };
}

module.exports = { startHeartbeat, DEFAULT_HEARTBEAT_INTERVAL_MS };
