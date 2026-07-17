"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../lib/config");
const { fetchUpstream, readUpstreamChatCompletion, pipeStream, eachSseData, abortOnClientClose } = require("../lib/upstream");
const { startServer } = require("../lib/server");
const { ResponsesWriter } = require("../lib/converters/responses");
const { streamAnthropic } = require("../lib/converters/anthropic");
const { writeWithBackpressure } = require("../lib/http-util");

const encoder = new TextEncoder();

function writeConfig(directory, name, server) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify({
    server,
    upstream: {
      baseUrl: "https://api.example.com/v1",
      model: "test-model",
      apiKeyEnv: "SECURITY_HTTP_TEST_KEY",
    },
  }));
  return file;
}

async function withServer(handler, callback) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await callback(server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function upstream(port, overrides = {}) {
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "test-model",
    apiKeyEnv: "SECURITY_HTTP_TEST_KEY",
    timeoutMs: 1000,
    maxResponseBytes: 1024 * 1024,
    maxSseEventBytes: 64 * 1024,
    ...overrides,
  };
}

function streamFromStrings(parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

function backpressureSink() {
  const sink = new EventEmitter();
  sink.destroyed = false;
  sink.writableEnded = false;
  sink.headersSent = false;
  sink.output = [];
  sink.failNextWrite = false;
  sink.writeHead = () => { sink.headersSent = true; };
  sink.write = (chunk) => {
    sink.output.push(String(chunk));
    if (!sink.failNextWrite) return true;
    sink.failNextWrite = false;
    return false;
  };
  sink.end = () => { sink.writableEnded = true; };
  sink.destroy = () => {
    if (sink.destroyed) return;
    sink.destroyed = true;
    sink.emit("close");
  };
  return sink;
}

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function testListenerAuthenticationBoundary() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-http-security-"));
  try {
    assert.throws(
      () => loadConfig(writeConfig(tmp, "public-no-token.json", { host: "0.0.0.0", port: 37629 })),
      /server\.localToken.*loopback/i
    );

    const publicWithToken = loadConfig(writeConfig(tmp, "public-token.json", {
      host: "0.0.0.0",
      port: 37629,
      localToken: "local-access-token",
    }));
    assert.equal(publicWithToken.server.host, "0.0.0.0");

    const directUpstream = upstream(1);
    assert.throws(
      () => startServer({
        server: { host: "0.0.0.0", port: 0 },
        upstreams: [directUpstream],
        defaultUpstream: directUpstream,
      }),
      /server\.localToken.*loopback/i
    );

    for (const host of ["127.0.0.1", "127.25.0.4", "::1", "localhost"]) {
      const loaded = loadConfig(writeConfig(tmp, `loopback-${host.replaceAll(":", "_")}.json`, { host, port: 37629 }));
      assert.equal(loaded.server.host, host);
      assert.ok(Number.isSafeInteger(loaded.upstreams[0].maxResponseBytes));
      assert.ok(loaded.upstreams[0].maxResponseBytes > 0);
      assert.ok(Number.isSafeInteger(loaded.upstreams[0].maxSseEventBytes));
      assert.ok(loaded.upstreams[0].maxSseEventBytes > 0);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function testDeadlineCoversResponseBody() {
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"choices":[');
    setTimeout(() => res.end("]}"), 1200);
  }, async (port) => {
    const response = await fetchUpstream(upstream(port, { timeoutMs: 500 }), {
      model: "test-model",
      messages: [{ role: "user", content: "timeout" }],
      stream: false,
    });
    await assert.rejects(response.text(), /timed out|abort/i);
  });
}

async function testResponseByteLimitForNonStreamAndStream() {
  const fullBody = JSON.stringify({ choices: [{ message: { content: "response larger than the configured budget" } }] });
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(fullBody);
  }, async (port) => {
    const response = await fetchUpstream(upstream(port, { maxResponseBytes: 24 }), {
      model: "test-model",
      messages: [{ role: "user", content: "bounded" }],
      stream: false,
    });
    await assert.rejects(response.text(), /configured limit/i);
  });

  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: first\n\n");
    res.write("data: second\n\n");
    res.end("data: third\n\n");
  }, async (port) => {
    const response = await fetchUpstream(upstream(port, { maxResponseBytes: 20 }), {
      model: "test-model",
      messages: [{ role: "user", content: "bounded stream" }],
      stream: true,
    });
    const sink = new EventEmitter();
    sink.destroyed = false;
    sink.writableEnded = false;
    sink.output = "";
    sink.write = (chunk) => {
      sink.output += Buffer.from(chunk).toString("utf8");
      return true;
    };
    sink.end = () => { sink.writableEnded = true; };
    await pipeStream(response.body, sink);
    assert.ok(Buffer.byteLength(sink.output) <= 20);
    assert.doesNotMatch(sink.output, /third/);
  });
}

async function testSseFramingAndEventLimit() {
  const data = [];
  await eachSseData(streamFromStrings([
    "data: first\r",
    "\n\r",
    "\ndata: sec",
    "ond\n",
    "\n",
  ]), (value) => data.push(value));
  assert.deepEqual(data, ["first", "second"]);

  const oversized = `data: ${"x".repeat(80)}`;
  await assert.rejects(
    eachSseData(streamFromStrings([oversized.slice(0, 20), oversized.slice(20)]), () => {}, { maxSseEventBytes: 32 }),
    /SSE event.*configured limit/i
  );
}

async function testNonStreamSseUsesConfiguredEventLimit() {
  const frame = JSON.stringify({
    choices: [{ index: 0, delta: { content: "x".repeat(256) }, finish_reason: "stop" }],
  });
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${frame}\n\ndata: [DONE]\n\n`);
  }, async (port) => {
    const response = await fetchUpstream(upstream(port, { maxSseEventBytes: 32 }), {
      model: "test-model",
      messages: [{ role: "user", content: "bounded non-stream SSE" }],
      stream: false,
    });
    await assert.rejects(
      readUpstreamChatCompletion(response),
      (error) => error?.code === "UPSTREAM_SSE_EVENT_TOO_LARGE"
    );
  });
}

async function testPipeStreamBackpressureAndClose() {
  const sink = new EventEmitter();
  sink.destroyed = false;
  sink.writableEnded = false;
  sink.output = [];
  sink.write = (chunk) => {
    sink.output.push(Buffer.from(chunk).toString("utf8"));
    return sink.output.length !== 1;
  };
  sink.end = () => { sink.writableEnded = true; };

  const piping = pipeStream(streamFromStrings(["one", "two"]), sink);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sink.output, ["one"]);
  assert.equal(sink.writableEnded, false);
  sink.emit("drain");
  await piping;
  assert.deepEqual(sink.output, ["one", "two"]);
  assert.equal(sink.writableEnded, true);

  let cancelled = false;
  const neverEnding = new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode("partial"));
      return new Promise(() => {});
    },
    cancel() { cancelled = true; },
  });
  const closingSink = new EventEmitter();
  closingSink.destroyed = false;
  closingSink.writableEnded = false;
  closingSink.write = () => false;
  closingSink.end = () => { closingSink.writableEnded = true; };
  const closingPipe = pipeStream(neverEnding, closingSink);
  await new Promise((resolve) => setImmediate(resolve));
  closingSink.destroyed = true;
  closingSink.emit("close");
  await closingPipe;
  assert.equal(cancelled, true);
  assert.equal(closingSink.writableEnded, false);

  let errorCancelled = false;
  const errorStream = new ReadableStream({
    pull(controller) {
      controller.enqueue(encoder.encode("partial"));
      return new Promise(() => {});
    },
    cancel() { errorCancelled = true; },
  });
  const errorSink = new EventEmitter();
  errorSink.destroyed = false;
  errorSink.writableEnded = false;
  errorSink.write = () => false;
  errorSink.end = () => { errorSink.writableEnded = true; };
  errorSink.destroy = () => {
    errorSink.destroyed = true;
    errorSink.emit("close");
  };
  const errorPipe = pipeStream(errorStream, errorSink);
  await new Promise((resolve) => setImmediate(resolve));
  errorSink.emit("error", new Error("downstream failed"));
  await errorPipe;
  assert.equal(errorCancelled, true);
  assert.equal(errorSink.destroyed, true);
  assert.equal(errorSink.writableEnded, false);
}

async function testBackpressureWaitHasDeadline() {
  const sink = new EventEmitter();
  sink.destroyed = false;
  sink.writableEnded = false;
  sink.write = () => false;
  sink.destroy = () => {
    sink.destroyed = true;
    sink.emit("close");
  };
  const started = Date.now();
  const written = await writeWithBackpressure(sink, "blocked", { timeoutMs: 25 });
  assert.equal(written, false);
  assert.equal(sink.destroyed, true);
  assert.ok(Date.now() - started < 500);
  assert.equal(sink.listenerCount("drain"), 0);
  assert.equal(sink.listenerCount("close"), 0);
  assert.equal(sink.listenerCount("error"), 0);
}

async function testClientAbortCancelsUpstream() {
  let upstreamClosed = false;
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: partial\n\n");
    res.on("close", () => { upstreamClosed = true; });
  }, async (port) => {
    const client = new AbortController();
    const response = await fetchUpstream(upstream(port), {
      model: "test-model",
      messages: [{ role: "user", content: "cancel" }],
      stream: true,
    }, { signal: client.signal });
    const body = response.text();
    client.abort();
    await assert.rejects(body, /abort/i);
    await waitFor(() => upstreamClosed);
  });
}

function testPreclosedClientAbortsImmediately() {
  const response = new EventEmitter();
  response.destroyed = true;
  response.writableEnded = false;
  const client = abortOnClientClose(response);
  assert.equal(client.signal.aborted, true);
  client.detach();
}

async function testResponsesSseHonorsBackpressure() {
  const sink = backpressureSink();
  const writer = new ResponsesWriter("test-model", sink);
  await writer.start();
  sink.failNextWrite = true;

  const processed = [];
  const processing = eachSseData(
    streamFromStrings(["data: first\n\ndata: second\n\n"]),
    async (data) => {
      processed.push(data);
      await writer.textDelta(data);
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(processed, ["first"]);
  assert.equal(sink.writableEnded, false);
  sink.emit("drain");
  await processing;
  assert.deepEqual(processed, ["first", "second"]);
  await writer.complete();
  assert.equal(sink.writableEnded, true);

  const failedSink = backpressureSink();
  failedSink.failNextWrite = true;
  const failedWriter = new ResponsesWriter("test-model", failedSink);
  const starting = failedWriter.start();
  await new Promise((resolve) => setImmediate(resolve));
  failedSink.emit("error", new Error("downstream failed"));
  await assert.rejects(starting, /Downstream connection closed/);
  assert.equal(failedSink.destroyed, true);
}

async function testAnthropicSseHonorsBackpressure() {
  const sink = backpressureSink();
  sink.failNextWrite = true;
  const streaming = streamAnthropic(sink, {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text: "bounded output" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sink.output.length, 1);
  assert.equal(sink.writableEnded, false);
  sink.emit("drain");
  await streaming;
  assert.equal(sink.writableEnded, true);
  assert.match(sink.output.join(""), /message_stop/);

  const failedSink = backpressureSink();
  failedSink.failNextWrite = true;
  const failedStreaming = streamAnthropic(failedSink, {
    id: "msg_failed",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text: "closed output" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  failedSink.emit("error", new Error("downstream failed"));
  await failedStreaming;
  assert.equal(failedSink.destroyed, true);
}

async function testChatRejectsEmptyUpstreamBody() {
  await withServer((_req, res) => {
    res.writeHead(204);
    res.end();
  }, async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startServer({
      server: { host: "127.0.0.1", port: 0 },
      upstreams: [configuredUpstream],
      defaultUpstream: configuredUpstream,
    });
    if (!bridge.listening) await new Promise((resolve) => bridge.once("listening", resolve));
    const bridgePort = bridge.address().port;
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "empty stream" }],
          stream: true,
        }),
      });
      const text = await response.text();
      // Streaming path: the bridge commits SSE headers before fetching the
      // upstream, so an empty upstream body becomes an SSE error frame rather
      // than an HTTP 502. The client receives 200 + a `data: {...}` error and
      // `data: [DONE]`, matching the SSE protocol for in-stream failures.
      assert.equal(response.status, 200, text);
      assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
      assert.match(text, /data: /);
      assert.match(text, /upstream_error/);
      assert.match(text, /data: \[DONE\]/);
      const health = await fetch(`http://127.0.0.1:${bridgePort}/health`);
      assert.equal(health.status, 200);
    } finally {
      bridge.closeAllConnections?.();
      await new Promise((resolve) => bridge.close(resolve));
    }
  });
}

async function testBrowserRequestGuards() {
  let upstreamHits = 0;
  await withServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-guard",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    }));
  }, async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startServer({
      server: { host: "127.0.0.1", port: 0 },
      upstreams: [configuredUpstream],
      defaultUpstream: configuredUpstream,
    });
    if (!bridge.listening) await new Promise((resolve) => bridge.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${bridge.address().port}`;
    try {
      const simplePost = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", Origin: "https://attacker.example" },
        body: JSON.stringify({ model: "test-model", messages: [] }),
      });
      assert.equal(simplePost.status, 403);
      assert.equal(upstreamHits, 0);

      for (const pathname of [
        "/v1/chat/completions",
        "/v1/responses",
        "/v1/responses/compact",
        "/v1/messages",
        "/v1/messages/count_tokens",
      ]) {
        const wrongType = await fetch(`${baseUrl}${pathname}`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        });
        assert.equal(wrongType.status, 415, pathname);
      }
      assert.equal(upstreamHits, 0);

      const localBrowser = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Origin: "http://localhost:43210",
        },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "allowed" }],
          stream: false,
        }),
      });
      assert.equal(localBrowser.status, 200, await localBrowser.text());
      assert.equal(upstreamHits, 1);

      const health = await fetch(`${baseUrl}/health`, { headers: { Origin: "https://attacker.example" } });
      assert.equal(health.status, 200);
      const models = await fetch(`${baseUrl}/v1/models`, { headers: { Origin: "https://attacker.example" } });
      assert.equal(models.status, 200);
      assert.equal(upstreamHits, 1);
    } finally {
      bridge.closeAllConnections?.();
      await new Promise((resolve) => bridge.close(resolve));
    }
  });
}

async function main() {
  process.env.SECURITY_HTTP_TEST_KEY = "test-key";
  testListenerAuthenticationBoundary();
  await testDeadlineCoversResponseBody();
  await testResponseByteLimitForNonStreamAndStream();
  await testSseFramingAndEventLimit();
  await testNonStreamSseUsesConfiguredEventLimit();
  await testPipeStreamBackpressureAndClose();
  await testBackpressureWaitHasDeadline();
  await testClientAbortCancelsUpstream();
  testPreclosedClientAbortsImmediately();
  await testResponsesSseHonorsBackpressure();
  await testAnthropicSseHonorsBackpressure();
  await testChatRejectsEmptyUpstreamBody();
  await testBrowserRequestGuards();
  console.log("security HTTP tests passed");
}

main().catch(() => {
  console.error("security HTTP tests failed");
  process.exitCode = 1;
});
