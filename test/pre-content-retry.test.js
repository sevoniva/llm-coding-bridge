"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { createEventStore } = require("../lib/event-store");
const { createRequestState } = require("../lib/request-state");
const { createRouteHealthRegistry } = require("../lib/route-health");
const { runChatAttempts } = require("../lib/attempt-runner");

function sseData(delta) {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
}

async function startFakeUpstream() {
  let steps = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const step = steps.shift();
      if (!step) return res.writeHead(500).end();
      let payload = {};
      try { payload = JSON.parse(raw); } catch {}
      const record = {
        authorization: req.headers.authorization,
        model: payload.model,
        previousBodyCancelled: step.previousBody ? step.previousBody.closed : undefined,
      };
      requests.push(record);

      if (step.type === "reset") {
        req.socket.destroy();
        return;
      }
      if (step.type === "slow_headers") {
        const timer = setTimeout(() => res.writeHead(200, { "Content-Type": "application/json" }).end("{}"), 250);
        req.once("close", () => clearTimeout(timer));
        return;
      }
      if (step.type === "slow_first") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        const timer = setTimeout(() => res.end(sseData({ content: "late" })), 250);
        req.once("close", () => clearTimeout(timer));
        return;
      }
      if (step.type === "idle") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(sseData({ role: "assistant" }));
        const timer = setTimeout(() => res.end(sseData({ content: "late" })), 250);
        req.once("close", () => clearTimeout(timer));
        return;
      }
      if (step.type === "status_stream") {
        step.closed = false;
        res.once("close", () => { step.closed = true; });
        res.writeHead(step.status, { "Content-Type": "text/plain" });
        res.write("failure body remains open");
        return;
      }
      if (step.type === "status") {
        res.writeHead(step.status, {
          "Content-Type": "application/json",
          ...(step.retryAfter ? { "Retry-After": step.retryAfter } : {}),
        });
        res.end(JSON.stringify({ error: { code: "temporary" } }));
        return;
      }
      if (step.type === "invalid_json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{");
        return;
      }
      if (step.type === "json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          id: "completion-1",
          object: "chat.completion",
          model: payload.model,
          choices: [{ index: 0, message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }],
        }));
        return;
      }
      if (step.type === "sse_reset") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const frame of step.frames) res.write(frame);
        setTimeout(() => req.socket.destroy(), 5);
        return;
      }
      if (step.type === "sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const frame of step.frames || [sseData({ content: "recovered" })]) res.write(frame);
        res.end("data: [DONE]\n\n");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    script(nextSteps) {
      steps = nextSteps;
      requests.length = 0;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const fake = await startFakeUpstream();
  let key = "key-one";
  let invalidations = 0;
  const credentialResolver = {
    resolve(reference) {
      assert.equal(reference, "credential-a");
      return key;
    },
    invalidate(reference) {
      assert.equal(reference, "credential-a");
      invalidations += 1;
      key = "key-two";
    },
  };
  const route = {
    alias: "coding-fast",
    upstreamModel: "upstream-model-a",
    model: "upstream-model-a",
    baseUrl: fake.baseUrl,
    credentialRef: "credential-a",
    reliability: {
      headerTimeoutMs: 100,
      firstDataTimeoutMs: 100,
      idleTimeoutMs: 100,
      nonStreamingTotalTimeoutMs: 500,
      streamingTotalTimeoutMs: 0,
    },
    timeoutMs: 500,
    maxResponseBytes: 1024 * 1024,
    maxSseEventBytes: 64 * 1024,
  };

  async function run(steps, options = {}) {
    fake.script(steps);
    const waits = [];
    const data = [];
    const completions = [];
    const eventStore = createEventStore();
    const requestState = createRequestState({ requestId: options.requestId || "request-1", model: route.alias });
    const result = await runChatAttempts({
      route,
      payload: { model: route.upstreamModel, messages: [{ role: "user", content: "test" }], stream: options.stream !== false },
      requestState,
      credentialResolver,
      healthRegistry: createRouteHealthRegistry(),
      eventStore,
      signal: options.signal,
      random: () => 0,
      wait: async (delayMs) => {
        waits.push(delayMs);
        await new Promise((resolve) => setTimeout(resolve, 10));
      },
      onData: async (value) => { data.push(value); },
      onJsonCompletion: async (value) => { completions.push(value); },
    });
    return { result, waits, data, completions, events: eventStore.snapshot(), requestState };
  }

  try {
    for (const first of [
      { type: "reset" },
      { type: "slow_headers" },
      { type: "slow_first" },
      { type: "idle" },
      { type: "status", status: 408 },
      { type: "status", status: 500 },
      { type: "status", status: 503 },
      { type: "invalid_json" },
    ]) {
      const recovered = await run([first, { type: "sse" }]);
      assert.equal(fake.requests.length, 2, first.type);
      assert.equal(recovered.data.some((value) => value.includes("recovered")), true, first.type);
      assert.equal(recovered.events.filter((event) => event.type === "attempt_start").length, 2, first.type);
    }

    const rateLimited = await run([
      { type: "status", status: 429, retryAfter: "1" },
      { type: "sse" },
    ]);
    assert.deepEqual(rateLimited.waits, [1000]);

    key = "key-one";
    invalidations = 0;
    await run([{ type: "status", status: 401 }, { type: "json" }], { stream: false });
    assert.equal(invalidations, 1);
    assert.deepEqual(fake.requests.map((request) => request.authorization), ["Bearer key-one", "Bearer key-two"]);

    const json = await run([{ type: "json" }], { stream: true });
    assert.equal(json.completions[0].choices[0].message.content, "recovered");

    const openBody = { type: "status_stream", status: 503, closed: false };
    await run([openBody, { type: "sse", previousBody: openBody }]);
    assert.equal(fake.requests[1].previousBodyCancelled, true);

    for (const delta of [
      { content: "text" },
      { reasoning_content: "reasoning" },
      { refusal: "no" },
      { tool_calls: [{ function: { name: "lookup" } }] },
      { tool_calls: [{ function: { arguments: "{\"q\":" } }] },
    ]) {
      fake.script([{ type: "sse_reset", frames: [sseData(delta)] }, { type: "sse" }]);
      const requestState = createRequestState({ requestId: "no-replay", model: route.alias });
      await assert.rejects(runChatAttempts({
        route,
        payload: { model: route.upstreamModel, messages: [], stream: true },
        requestState,
        credentialResolver,
        healthRegistry: createRouteHealthRegistry(),
        eventStore: createEventStore(),
        random: () => 0,
        wait: async () => {},
        onData: async () => {},
      }));
      assert.equal(fake.requests.length, 1, JSON.stringify(delta));
      assert.equal(requestState.semanticContentStarted, true);
    }

    for (const frames of [
      [sseData({ role: "assistant" })],
      [`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 0 } })}\n\n`],
      [sseData({})],
    ]) {
      const recovered = await run([{ type: "sse_reset", frames }, { type: "sse" }]);
      assert.equal(fake.requests.length, 2);
      assert.equal(recovered.requestState.semanticContentStarted, true);
    }

    for (const request of fake.requests) {
      assert.equal(request.model, "upstream-model-a");
      assert.equal(request.authorization, "Bearer key-two");
    }

    const controller = new AbortController();
    controller.abort();
    fake.script([{ type: "sse" }]);
    await assert.rejects(runChatAttempts({
      route,
      payload: { model: route.upstreamModel, messages: [], stream: true },
      requestState: createRequestState({ requestId: "cancelled", model: route.alias }),
      credentialResolver,
      healthRegistry: createRouteHealthRegistry(),
      signal: controller.signal,
    }), (error) => error.category === "cancelled" && error.retryable === false);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }

  console.log("pre-content retry tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
