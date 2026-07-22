"use strict";

// Streaming keepalive tests: verifies the bridge sends SSE headers + heartbeats
// BEFORE the upstream returns its first byte, so clients with short idle timeouts
// (e.g. ZCode subagents) do not cancel the request during the upstream "thinking"
// dead zone. See GitHub issue #5: "Agent was cancelled before the subagent
// returned findings or background launch completed".

const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { startServer } = require("../lib/server");
const { startHeartbeat } = require("../lib/heartbeat");
const { ResponsesWriter } = require("../lib/converters/responses");
const { streamAnthropic } = require("../lib/converters/anthropic");

// ---------- shared helpers (mirror security-http.test.js conventions) ----------

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
    apiKeyEnv: "STREAMING_KEEPALIVE_TEST_KEY",
    timeoutMs: 5000,
    maxResponseBytes: 1024 * 1024,
    maxSseEventBytes: 64 * 1024,
    ...overrides,
  };
};

function startBridge(configuredUpstream, serverOverrides = {}) {
  const bridge = startServer({
    server: { host: "127.0.0.1", port: 0, heartbeatIntervalMs: 200, ...serverOverrides },
    upstreams: [configuredUpstream],
    defaultUpstream: configuredUpstream,
  });
  return bridge;
}

async function bridgePort(bridge) {
  if (!bridge.listening) await new Promise((resolve) => bridge.once("listening", resolve));
  return bridge.address().port;
}

async function closeBridge(bridge) {
  bridge.closeAllConnections?.();
  await new Promise((resolve) => bridge.close(resolve));
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

// Read the first chunk from a streaming response, with a deadline. Returns the
// chunk text (or "" if the stream ended) so callers can assert on early bytes.
async function readFirstChunk(response, timeoutMs = 1500) {
  const reader = response.body.getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs)),
  ]);
  return { reader, first };
}

// ---------- tests ----------

// 1. Heartbeat helper: writes `: ping\n\n`, stop() is idempotent, clear on close, .unref.
async function testHeartbeatHelper() {
  // No-op when intervalMs <= 0.
  const noop = startHeartbeat({ destroyed: false, writableEnded: false, write: () => true, on: () => {}, off: () => {} }, 0);
  noop.stop();
  noop.stop(); // idempotent

  // Real heartbeat writes comment frames periodically.
  const sink = backpressureSink();
  let heartbeatEvents = 0;
  let clockReads = 0;
  const handle = startHeartbeat(sink, 50, {
    now: () => { clockReads += 1; return Date.now(); },
    onHeartbeat: () => { heartbeatEvents += 1; },
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
  handle.stop();
  const joined = sink.output.join("");
  assert.match(joined, /^: ping\n\n/, `expected leading ping frame, got: ${JSON.stringify(joined)}`);
  const pingCount = (joined.match(/^: ping\n\n/gm) || []).length;
  assert.ok(pingCount >= 2, `expected at least 2 pings in 180ms with 50ms interval, got ${pingCount}`);
  assert.equal(heartbeatEvents, pingCount);
  assert.ok(clockReads >= heartbeatEvents);
  // After stop(), no more pings arrive.
  const before = sink.output.length;
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(sink.output.length, before, "heartbeat wrote after stop()");

  // Auto-clear on close.
  const closingSink = backpressureSink();
  const handle2 = startHeartbeat(closingSink, 30);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const beforeClose = closingSink.output.length;
  closingSink.destroy();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(closingSink.output.length, beforeClose, "heartbeat wrote after res close");

  // Stop on write failure (client dead). The sink's write returns false AND
  // triggers a close, mirroring a real bounded socket that rejects a write.
  const deadSink = backpressureSink();
  deadSink.write = () => {
    // Simulate a socket that has been destroyed mid-write: return false and
    // tear down so the heartbeat's waitForDrain resolves via the close path.
    deadSink.destroy();
    return false;
  };
  const handle3 = startHeartbeat(deadSink, 30);
  await new Promise((resolve) => setTimeout(resolve, 120));
  handle3.stop();
  assert.equal(deadSink.destroyed, true, "dead sink should be destroyed after write failure");
  // Heartbeat must not throw after the sink is gone.
  handle3.stop();
}

// 2. Chat path: with a slow upstream (headers delayed 800ms), the client receives
//    HTTP 200 + SSE headers + a valid empty completion event BEFORE the upstream responds.
async function testChatEmitsHeadersBeforeUpstream() {
  let upstreamGotRequest = false;
  await withServer((_req, res) => {
    upstreamGotRequest = true;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 800);
  }, async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startBridge(configuredUpstream);
    const bPort = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${bPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const { reader, first } = await readFirstChunk(response, 600);
      const firstText = first.value ? new TextDecoder().decode(first.value) : "";
      // Must receive a parseable OpenAI data event BEFORE the upstream responds.
      const heartbeatLine = firstText.split("\n").find((line) => line.startsWith("data: "));
      assert.ok(heartbeatLine, `expected data heartbeat before upstream responds, got: ${JSON.stringify(firstText)}`);
      const heartbeat = JSON.parse(heartbeatLine.slice(6));
      assert.equal(heartbeat.object, "chat.completion.chunk");
      assert.equal(heartbeat.model, "test-model");
      assert.deepEqual(heartbeat.choices[0].delta, {});
      assert.ok(upstreamGotRequest, "upstream should have been called");
      reader.cancel().catch(() => {});
    } finally {
      await closeBridge(bridge);
    }
  });
}

// 3. Chat path: a valid empty completion event keeps the client active when the
//    upstream stalls after its first real byte.
async function testChatHeartbeatContinuesDuringMidStreamIdle() {
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    // Then stall long enough for multiple downstream heartbeat intervals.
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"second"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 400);
  }, async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startBridge(configuredUpstream, { heartbeatIntervalMs: 100 });
    const bPort = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${bPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const text = await response.text();
      // Should contain the real chunks and [DONE].
      assert.match(text, /"first"/);
      assert.match(text, /"second"/);
      assert.match(text, /data: \[DONE\]/);
      const firstIdx = text.indexOf('"first"');
      const secondIdx = text.indexOf('"second"');
      assert.ok(firstIdx >= 0 && secondIdx > firstIdx, "both chunks should be present in order");
      const between = text.slice(firstIdx, secondIdx);
      const heartbeatLine = between
        .split("\n")
        .find((line) => line.startsWith("data: ") && line.includes('"chat.completion.chunk"'));
      assert.ok(heartbeatLine, `missing data heartbeat during upstream gap: ${JSON.stringify(between)}`);
      const heartbeat = JSON.parse(heartbeatLine.slice(6));
      assert.equal(heartbeat.model, "test-model");
      assert.deepEqual(heartbeat.choices[0].delta, {});
      assert.equal(heartbeat.choices[0].finish_reason, null);
    } finally {
      await closeBridge(bridge);
    }
  });
}

// 4. Chat path: an upstream transport reset must remain a downstream network
//    failure so clients such as ZCode can apply their retry policy.
async function testChatTransportFailureResetsDownstream() {
  await withServer((req) => req.socket.destroy(), async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startBridge(configuredUpstream, { heartbeatIntervalMs: 100 });
    const bPort = await bridgePort(bridge);
    try {
      await assert.rejects(async () => {
        const response = await fetch(`http://127.0.0.1:${bPort}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "test-model",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          }),
        });
        await response.text();
      }, "expected upstream reset to reject the downstream stream");
      const health = await fetch(`http://127.0.0.1:${bPort}/health`);
      assert.equal(health.status, 200);
    } finally {
      await closeBridge(bridge);
    }
  });
}

// 5. Chat path: upstream 204 (no body) on a stream:true request → bridge emits
//    HTTP 200 + SSE error data frame + [DONE] (NOT 502 JSON).
async function testChatStreamErrorOnUpstream204() {
  await withServer((_req, res) => {
    res.writeHead(204);
    res.end();
  }, async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startBridge(configuredUpstream);
    const bPort = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${bPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "empty stream" }],
          stream: true,
        }),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      assert.match(text, /data: /);
      assert.match(text, /upstream_error/);
      assert.match(text, /data: \[DONE\]/);
      const health = await fetch(`http://127.0.0.1:${bPort}/health`);
      assert.equal(health.status, 200);
    } finally {
      await closeBridge(bridge);
    }
  });
}

// 6. Chat path: some OpenAI-compatible upstreams intermittently ignore
//    stream:true and return a normal JSON chat completion. Convert that
//    completion to valid downstream SSE so a long ZCode turn can continue.
async function testChatNormalizesJsonFallbackForStream() {
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-json-fallback",
      object: "chat.completion",
      created: 123,
      model: "test-model",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "fallback text",
          reasoning_content: "fallback reasoning",
          tool_calls: [{
            id: "call_json_fallback",
            type: "function",
            function: { name: "Write", arguments: "{\"path\":\"file.txt\"}" },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  }, async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startBridge(configuredUpstream);
    const bPort = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${bPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      assert.doesNotMatch(text, /upstream_error|non-SSE/);
      assert.match(text, /data: \[DONE\]/);
      const frames = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)));
      const completion = frames.find((frame) => frame.choices?.length > 0);
      assert.equal(completion.id, "chatcmpl-json-fallback");
      assert.equal(completion.object, "chat.completion.chunk");
      assert.equal(completion.choices[0].delta.content, "fallback text");
      assert.equal(completion.choices[0].delta.reasoning_content, "fallback reasoning");
      assert.equal(completion.choices[0].delta.tool_calls[0].function.name, "Write");
      assert.equal(completion.choices[0].finish_reason, "tool_calls");
      const usage = frames.find((frame) => frame.choices?.length === 0 && frame.usage);
      assert.equal(usage.usage.total_tokens, 15);
    } finally {
      await closeBridge(bridge);
    }
  });
}

// 7. A HTTP 200 JSON error is still a protocol failure for stream:true. Reset
//    the downstream connection instead of emitting a terminal SSE error so
//    ZCode can use its configured network retry attempts.
async function testChatInvalidJsonFallbackRemainsRetryable() {
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: {
        message: "temporary upstream gateway error",
        type: "server_error",
        code: "overloaded",
      },
    }));
  }, async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startBridge(configuredUpstream);
    const bPort = await bridgePort(bridge);
    try {
      await assert.rejects(async () => {
        const response = await fetch(`http://127.0.0.1:${bPort}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "test-model",
            messages: [{ role: "user", content: "hi" }],
            stream: true,
          }),
        });
        await response.text();
      }, "expected invalid non-SSE fallback to reject the downstream stream");
      const health = await fetch(`http://127.0.0.1:${bPort}/health`);
      assert.equal(health.status, 200);
    } finally {
      await closeBridge(bridge);
    }
  });
}

// 8. Chat path: non-stream (stream:false) behavior unchanged — fetch then sendJson.
async function testChatNonStreamUnchanged() {
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    }));
  }, async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startBridge(configuredUpstream);
    const bPort = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${bPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });
      const data = await response.json();
      assert.equal(response.status, 200);
      assert.equal(data.object, "chat.completion");
      assert.equal(data.choices[0].message.content, "hello");
    } finally {
      await closeBridge(bridge);
    }
  });
}

// 7. Responses path: response.created + response.in_progress emitted BEFORE upstream
//    responds (slow upstream).
async function testResponsesEmitsCreatedBeforeUpstream() {
  await withServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 800);
  }, async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startBridge(configuredUpstream);
    const bPort = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${bPort}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          input: "hi",
          stream: true,
        }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const { reader, first } = await readFirstChunk(response, 600);
      const firstText = first.value ? new TextDecoder().decode(first.value) : "";
      // Must contain response.created BEFORE the 800ms upstream delay elapses.
      assert.match(firstText, /event: response\.created/, `expected response.created before upstream, got: ${JSON.stringify(firstText)}`);
      assert.match(firstText, /event: response\.in_progress/, `expected response.in_progress before upstream, got: ${JSON.stringify(firstText)}`);
      reader.cancel().catch(() => {});
    } finally {
      await closeBridge(bridge);
    }
  });
}

// 8. Responses path: fetch throw after writer.start() → emits response.failed (not
//    a torn-down connection).
async function testResponsesFailOnFetchThrow() {
  await withServer((_req, res) => {
    // Upstream returns 500 → bridge's !ok branch → writer.fail("Upstream error.")
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "upstream broken" }));
  }, async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startBridge(configuredUpstream);
    const bPort = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${bPort}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          input: "hi",
          stream: true,
        }),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.match(text, /event: response\.created/);
      assert.match(text, /event: response\.failed/);
      assert.match(text, /upstream_error/);
      assert.match(text, /data: \[DONE\]/);
    } finally {
      await closeBridge(bridge);
    }
  });
}

// 9. Anthropic path: streaming — writeHead + heartbeat emitted BEFORE upstream
//    responds (slow upstream, fully-buffered path).
async function testAnthropicEmitsHeadersBeforeUpstream() {
  await withServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }));
    }, 800);
  }, async (port) => {
    const configuredUpstream = upstream(port);
    const bridge = startBridge(configuredUpstream);
    const bPort = await bridgePort(bridge);
    try {
      const response = await fetch(`http://127.0.0.1:${bPort}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test-model",
          max_tokens: 64,
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      const { reader, first } = await readFirstChunk(response, 600);
      const firstText = first.value ? new TextDecoder().decode(first.value) : "";
      assert.match(firstText, /: ping/, `expected ping before upstream responds, got: ${JSON.stringify(firstText)}`);
      reader.cancel().catch(() => {});
    } finally {
      await closeBridge(bridge);
    }
  });
}

// 10. streamAnthropic public signature preserved: still does writeHead + full event
//     chain. Mirrors the contract in testAnthropicSseHonorsBackpressure.
async function testStreamAnthropicPublicSignaturePreserved() {
  const sink = backpressureSink();
  await streamAnthropic(sink, {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text: "bounded output" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  assert.equal(sink.headersSent, true, "streamAnthropic should still call writeHead");
  assert.equal(sink.writableEnded, true, "streamAnthropic should end the response");
  assert.match(sink.output.join(""), /message_start/);
  assert.match(sink.output.join(""), /content_block_delta/);
  assert.match(sink.output.join(""), /message_stop/);
}

async function main() {
  process.env.STREAMING_KEEPALIVE_TEST_KEY = "test-key";
  await testHeartbeatHelper();
  console.log("testHeartbeatHelper passed");
  await testChatEmitsHeadersBeforeUpstream();
  console.log("testChatEmitsHeadersBeforeUpstream passed");
  await testChatHeartbeatContinuesDuringMidStreamIdle();
  console.log("testChatHeartbeatContinuesDuringMidStreamIdle passed");
  await testChatTransportFailureResetsDownstream();
  console.log("testChatTransportFailureResetsDownstream passed");
  await testChatStreamErrorOnUpstream204();
  console.log("testChatStreamErrorOnUpstream204 passed");
  await testChatNormalizesJsonFallbackForStream();
  console.log("testChatNormalizesJsonFallbackForStream passed");
  await testChatInvalidJsonFallbackRemainsRetryable();
  console.log("testChatInvalidJsonFallbackRemainsRetryable passed");
  await testChatNonStreamUnchanged();
  console.log("testChatNonStreamUnchanged passed");
  await testResponsesEmitsCreatedBeforeUpstream();
  console.log("testResponsesEmitsCreatedBeforeUpstream passed");
  await testResponsesFailOnFetchThrow();
  console.log("testResponsesFailOnFetchThrow passed");
  await testAnthropicEmitsHeadersBeforeUpstream();
  console.log("testAnthropicEmitsHeadersBeforeUpstream passed");
  await testStreamAnthropicPublicSignaturePreserved();
  console.log("testStreamAnthropicPublicSignaturePreserved passed");
  console.log("streaming-keepalive tests passed");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
