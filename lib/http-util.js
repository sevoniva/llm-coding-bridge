"use strict";

const DEFAULT_DRAIN_TIMEOUT_MS = 30 * 1000;

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function waitForDrain(res, timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (drained) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onClose);
      resolve(drained);
    };
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onClose);
    timer = setTimeout(() => finish(false), timeoutMs);
    if (res.destroyed || res.writableEnded) finish(false);
    else if (res.writableNeedDrain === false) finish(true);
  });
}

async function writeWithBackpressure(res, chunk, options = {}) {
  if (res.destroyed || res.writableEnded) return false;
  try {
    if (res.write(chunk)) return true;
  } catch {
    if (!res.destroyed && typeof res.destroy === "function") res.destroy();
    return false;
  }
  const drained = await waitForDrain(res, options.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS);
  if (!drained && !res.destroyed && typeof res.destroy === "function") res.destroy();
  return drained;
}

function writeSse(res, event, body) {
  return writeWithBackpressure(res, `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}

function debug(message) {
  if (process.env.LLM_CODING_BRIDGE_DEBUG) console.error(`[debug] ${message}`);
}

module.exports = { sendJson, writeSse, writeWithBackpressure, debug, DEFAULT_DRAIN_TIMEOUT_MS };
