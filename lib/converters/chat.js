"use strict";

const { fetchUpstream, pipeStream } = require("../upstream");
const { registerStream } = require("../streams");
const { sendJson } = require("../http-util");

async function handleChat(upstream, payload, res) {
  const upstreamPayload = { ...payload, model: upstream.model };
  const upstreamRes = await fetchUpstream(upstream, upstreamPayload);
  if (!upstreamRes.ok) {
    await upstreamRes.text();
    sendJson(res, upstreamRes.status, { error: { message: `Upstream HTTP ${upstreamRes.status}.`, type: "upstream_error" } });
    return;
  }
  if (!payload.stream) {
    sendJson(res, upstreamRes.status, await upstreamRes.json());
    return;
  }
  res.writeHead(200, {
    "Content-Type": upstreamRes.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  registerStream(res);
  await pipeStream(upstreamRes.body, res);
}

module.exports = { handleChat };
