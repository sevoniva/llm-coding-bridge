"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { chatClientCompatibility } = require("../lib/chat-client-compat");
const { startServer } = require("../lib/server");

const HARNESS_USER_AGENT = "deepseek-harness/0.1.0-test (+https://example.invalid/harness)";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function withUpstream(handler, callback) {
  const upstream = http.createServer(handler);
  const port = await listen(upstream);
  try {
    await callback(port);
  } finally {
    await close(upstream);
  }
}

function startBridge(upstreamPort, server = {}, routeOverrides = {}) {
  const route = {
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    model: "wire-model",
    alias: "client-model",
    apiKeyEnv: "HARNESS_COMPAT_TEST_KEY",
    timeoutMs: 2_000,
    maxResponseBytes: 1024 * 1024,
    maxSseEventBytes: 64 * 1024,
    ...routeOverrides,
  };
  return startServer({
    server: { host: "127.0.0.1", port: 0, heartbeatIntervalMs: 20, ...server },
    upstreams: [route],
    defaultUpstream: route,
  });
}

async function bridgePort(bridge) {
  if (!bridge.listening) await new Promise((resolve) => bridge.once("listening", resolve));
  return bridge.address().port;
}

function harnessHeaders(extra = {}) {
  return {
    "content-type": "application/json",
    "user-agent": HARNESS_USER_AGENT,
    "x-deepseek-harness-user-id": "00000000-0000-4000-8000-000000000001",
    ...extra,
  };
}

function chatBody(overrides = {}) {
  return {
    model: "client-model",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    stream_options: { include_usage: true },
    ...overrides,
  };
}

async function testClientDetectionAndHeaderSelection() {
  const compatible = chatClientCompatibility({
    headers: harnessHeaders({
      authorization: "Bearer must-not-forward",
      "x-deepseek-harness-session-id": "session-1",
      "x-deepseek-harness-compact": "1",
      "x-unrelated": "must-not-forward",
    }),
  });
  assert.equal(compatible.deferStreamHeaders, true);
  assert.equal(compatible.preserveEmptyAssistantContent, true);
  assert.deepEqual(compatible.upstreamHeaders, {
    "user-agent": HARNESS_USER_AGENT,
    "x-deepseek-harness-user-id": "00000000-0000-4000-8000-000000000001",
    "x-deepseek-harness-session-id": "session-1",
    "x-deepseek-harness-compact": "1",
  });

  const generic = chatClientCompatibility({ headers: { "user-agent": "generic-client/1.0" } });
  assert.equal(generic.deferStreamHeaders, false);
  assert.equal(generic.preserveEmptyAssistantContent, false);
  assert.deepEqual(generic.upstreamHeaders, {});
}

async function testRequestSemanticsAndHeadersReachUpstream() {
  let receivedBody;
  let receivedHeaders;
  await withUpstream(async (req, res) => {
    receivedHeaders = req.headers;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl-test",
      model: "wire-model",
      choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    })}\n\n`);
    res.end("data: [DONE]\n\n");
  }, async (upstreamPort) => {
    const bridge = startBridge(upstreamPort, {}, {
      translateThinkingToReasoningEffort: true,
      maxOutputTokens: 131072,
    });
    const port = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: harnessHeaders({
          authorization: "Bearer client-facing-key",
          "x-deepseek-harness-session-id": "session-1",
          "x-deepseek-harness-compact": "1",
          "x-unrelated": "must-not-forward",
        }),
        body: JSON.stringify(chatBody({
          thinking: { type: "enabled" },
          reasoning_effort: "high",
          max_tokens: 256000,
          messages: [
            { role: "user", content: "use the tool" },
            {
              role: "assistant",
              content: "",
              reasoning_content: "reasoning passback",
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: { name: "lookup", arguments: "{\"id\":1}" },
              }],
            },
            { role: "tool", tool_call_id: "call-1", content: "result" },
          ],
        })),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      assert.match(text, /data: \[DONE\]/);
    } finally {
      await close(bridge);
    }
  });

  assert.equal(receivedBody.model, "wire-model");
  assert.equal(receivedBody.messages[1].content, "");
  assert.equal(receivedBody.messages[1].reasoning_content, "reasoning passback");
  assert.equal(Object.hasOwn(receivedBody, "thinking"), false);
  assert.equal(receivedBody.reasoning_effort, "high");
  assert.equal(receivedBody.max_tokens, 131072);
  assert.equal(receivedHeaders["user-agent"], HARNESS_USER_AGENT);
  assert.equal(receivedHeaders["x-deepseek-harness-session-id"], "session-1");
  assert.equal(receivedHeaders["x-deepseek-harness-compact"], "1");
  assert.equal(receivedHeaders.authorization, "Bearer upstream-test-key");
  assert.equal(receivedHeaders["x-unrelated"], undefined);
}

async function testHttpErrorsRemainHttpErrors() {
  await withUpstream((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid request" } }));
  }, async (upstreamPort) => {
    const bridge = startBridge(upstreamPort);
    const port = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: harnessHeaders(),
        body: JSON.stringify(chatBody()),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.type, "upstream_error");
      assert.equal(body.error.code, "UPSTREAM_HTTP_400");
    } finally {
      await close(bridge);
    }
  });
}

async function testEmbeddedHttpErrorsRemainHttpErrors() {
  let attempts = 0;
  await withUpstream((_req, res) => {
    attempts += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 400, error: "unsupported request field" }));
  }, async (upstreamPort) => {
    const bridge = startBridge(upstreamPort);
    const port = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: harnessHeaders(),
        body: JSON.stringify(chatBody()),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.code, "UPSTREAM_HTTP_400");
      assert.equal(attempts, 1);
    } finally {
      await close(bridge);
    }
  });
}

async function testCommentHeartbeatSupportsTransportWatchdogs() {
  await withUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    setTimeout(() => {
      if (res.destroyed || res.writableEnded) return;
      res.write('data: {"choices":[{"index":0,"delta":{"content":"late"},"finish_reason":"stop"}]}\n\n');
      res.end("data: [DONE]\n\n");
    }, 120);
  }, async (upstreamPort) => {
    const bridge = startBridge(upstreamPort);
    const port = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: harnessHeaders(),
        body: JSON.stringify(chatBody()),
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const first = await reader.read();
      const text = new TextDecoder().decode(first.value);
      assert.match(text, /: ping\n\n/);
      assert.match(text, /"chat\.completion\.chunk"/);
      await reader.cancel();
    } finally {
      await close(bridge);
    }
  });
}

async function main() {
  process.env.HARNESS_COMPAT_TEST_KEY = "upstream-test-key";
  await testClientDetectionAndHeaderSelection();
  await testRequestSemanticsAndHeadersReachUpstream();
  await testHttpErrorsRemainHttpErrors();
  await testEmbeddedHttpErrorsRemainHttpErrors();
  await testCommentHeartbeatSupportsTransportWatchdogs();
  console.log("DeepSeek Harness compatibility tests passed");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
