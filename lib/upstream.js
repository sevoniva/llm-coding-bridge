"use strict";

const { getApiKey, bustApiKey, upstreamUrl } = require("./config");
const { parseNonStreamChatResponse } = require("./chat-compat");

async function fetchUpstream(upstream, payload) {
  const timeoutMs = Number(upstream.timeoutMs || 600000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(upstreamUrl(upstream), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey(upstream)}`,
        "Content-Type": "application/json",
        Accept: payload.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // 401 may mean the cached key rotated; bust so the next request re-resolves.
    if (response.status === 401) bustApiKey(upstream);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstreamJson(upstream, payload) {
  const response = await fetchUpstream(upstream, { ...payload, stream: false });
  if (!response.ok) {
    await response.text();
    throw new Error(`Upstream HTTP ${response.status}.`);
  }
  return readUpstreamChatCompletion(response);
}

async function readUpstreamChatCompletion(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  const { completion, normalizedSse } = parseNonStreamChatResponse(text, contentType);
  if (normalizedSse) {
    console.error(`[compat] normalized non-stream SSE response status=${response.status} content-type=${contentType || "unknown"}`);
  }
  return completion;
}

async function pipeStream(upstreamBody, res) {
  const reader = upstreamBody.getReader();
  let aborted = false;
  const onClose = () => { aborted = true; reader.cancel().catch(() => {}); };
  res.on("close", onClose);
  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // abort 或写失败，静默
  } finally {
    res.off("close", onClose);
    if (!aborted) reader.cancel().catch(() => {});
  }
  res.end();
}

async function eachSseData(body, onData) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let start = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      // ponytail: index-pointer scan instead of buffer=slice() to keep this linear over long streams
      while ((boundary = buffer.indexOf("\n\n", start)) >= 0) {
        const event = buffer.slice(start, boundary);
        start = boundary + 2;
        const lines = event.split(/\r?\n/).filter((line) => line.startsWith("data:"));
        if (lines.length) onData(lines.map((line) => line.slice(5).trimStart()).join("\n"));
      }
      if (start > 0) {
        buffer = buffer.slice(start);
        start = 0;
      }
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
}

module.exports = { fetchUpstream, fetchUpstreamJson, readUpstreamChatCompletion, pipeStream, eachSseData };
