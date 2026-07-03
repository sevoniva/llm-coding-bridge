"use strict";

const { getApiKey, upstreamUrl } = require("./config");

async function fetchUpstream(upstream, payload) {
  const timeoutMs = Number(upstream.timeoutMs || 600000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(upstreamUrl(upstream), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey(upstream)}`,
        "Content-Type": "application/json",
        Accept: payload.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstreamJson(upstream, payload) {
  const response = await fetchUpstream(upstream, { ...payload, stream: false });
  const text = await response.text();
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}.`);
  return JSON.parse(text);
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
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const lines = event.split(/\r?\n/).filter((line) => line.startsWith("data:"));
      if (lines.length) onData(lines.map((line) => line.slice(5).trimStart()).join("\n"));
    }
  }
}

module.exports = { fetchUpstream, fetchUpstreamJson, pipeStream, eachSseData };
