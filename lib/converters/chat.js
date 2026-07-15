"use strict";

const { sanitizeChatPayload } = require("../chat-compat");
const { fetchUpstream, readUpstreamChatCompletion, pipeStream, abortOnClientClose } = require("../upstream");
const { registerStream } = require("../streams");
const { sendJson, writeWithBackpressure } = require("../http-util");

async function handleChat(upstream, payload, res) {
  const upstreamPayload = { ...sanitizeChatPayload(payload, upstream), model: upstream.model };
  const client = abortOnClientClose(res);
  try {
    const upstreamRes = await fetchUpstream(upstream, upstreamPayload, { signal: client.signal });
    if (!upstreamRes.ok) {
      await upstreamRes.text();
      sendJson(res, upstreamRes.status, { error: { message: `Upstream HTTP ${upstreamRes.status}.`, type: "upstream_error" } });
      return;
    }
    if (!upstreamRes.body) {
      sendJson(res, 502, { error: { message: "Upstream returned an empty response.", type: "upstream_error" } });
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
      void (async () => {
        if (contentType.includes("text/event-stream") && !(await writeWithBackpressure(res, "data: [DONE]\n\n"))) {
          if (!res.destroyed) res.destroy();
          return;
        }
        if (!res.writableEnded) res.end();
      })().catch(() => {
        if (!res.destroyed) res.destroy();
      });
    });
    await pipeStream(upstreamRes.body, res);
  } finally {
    client.detach();
  }
}

module.exports = { handleChat };
