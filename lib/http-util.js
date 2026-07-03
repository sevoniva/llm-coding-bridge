"use strict";

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function writeSse(res, event, body) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

function debug(message) {
  if (process.env.LLM_CODING_BRIDGE_DEBUG) console.error(`[debug] ${message}`);
}

module.exports = { sendJson, writeSse, debug };
