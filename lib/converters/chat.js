"use strict";

const { sanitizeChatPayload } = require("../chat-compat");
const { fetchUpstream, readUpstreamChatCompletion, pipeStream } = require("../upstream");
const { registerStream } = require("../streams");
const { sendJson } = require("../http-util");

async function handleChat(upstream, payload, res) {
  const upstreamPayload = { ...sanitizeChatPayload(payload, upstream), model: upstream.model };
  const upstreamRes = await fetchUpstream(upstream, upstreamPayload);
  if (!upstreamRes.ok) {
    await upstreamRes.text();
    sendJson(res, upstreamRes.status, { error: { message: `Upstream HTTP ${upstreamRes.status}.`, type: "upstream_error" } });
    return;
  }
  if (!payload.stream) {
    sendJson(res, upstreamRes.status, await readUpstreamChatCompletion(upstreamRes));
    return;
  }
  const contentType = upstreamRes.headers.get("content-type") || "text/event-stream; charset=utf-8";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  registerStream(res, () => {
    // For SSE streams, emit the [DONE] sentinel OpenAI clients expect on clean
    // shutdown; for other content types just end.
    if (contentType.includes("text/event-stream")) res.write("data: [DONE]\n\n");
    res.end();
  });
  await pipeStream(upstreamRes.body, res);
}

module.exports = { handleChat };
