"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeConfigDocument } = require("../lib/config-v2");
const { createCredentialResolver } = require("../lib/credentials");
const { probeAllModels, probeModel } = require("../lib/doctor");
const { startServer } = require("../lib/server");
const { detectZcodeState, planZcodeChange } = require("../lib/zcode-client");
const { startFakeMultiModel } = require("./helpers/fake-multimodel-upstream");

const ROUTES = [
  { alias: "coding-fast", model: "provider-model-id-a", env: "E2E_FAST_KEY" },
  { alias: "coding-strong", model: "provider-model-id-b", env: "E2E_STRONG_KEY" },
  { alias: "coding-long", model: "provider-model-id-c", env: "E2E_LONG_KEY" },
];

function secret(label) {
  return `e2e-${label}-${crypto.randomBytes(18).toString("hex")}`;
}

function configDocument(baseUrl) {
  return {
    version: 2,
    reliability: {
      headerTimeoutMs: 500,
      firstDataTimeoutMs: 150,
      idleTimeoutMs: 150,
      nonStreamingTotalTimeoutMs: 1000,
      streamingTotalTimeoutMs: 1500,
      downstreamHeartbeatIntervalMs: 15,
    },
    providers: [{
      id: "fixture-provider",
      name: "Fixture Provider",
      baseUrl,
      models: ROUTES.map((route) => ({
        alias: route.alias,
        upstreamModel: route.model,
        credentialRef: `${route.alias}-credential`,
      })),
    }],
    credentials: Object.fromEntries(ROUTES.map((route) => [
      `${route.alias}-credential`,
      { source: "env", env: route.env },
    ])),
  };
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function main() {
  const keys = Object.fromEntries(ROUTES.map((route) => [route.alias, secret(route.alias)]));
  const env = Object.fromEntries(ROUTES.map((route) => [route.env, keys[route.alias]]));
  const localToken = secret("local-token");
  const responseBodies = [];
  const capturedLogs = [];
  const originalConsoleError = console.error;
  const zcodeHome = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-multimodel-zcode-"));
  let bridge;
  let fake;

  console.error = (...args) => capturedLogs.push(args.map(String).join(" "));
  try {
    fake = await startFakeMultiModel({
      routes: ROUTES.map((route) => ({
        alias: route.alias,
        model: route.model,
        key: keys[route.alias],
      })),
      scripts: {},
    });
    const normalized = normalizeConfigDocument(configDocument(fake.baseUrl), "/tmp/multimodel-e2e.json");
    const credentialResolver = createCredentialResolver(normalized.credentials, {
      env,
      ttlMs: 60_000,
    });
    const config = {
      ...normalized,
      server: { host: "127.0.0.1", port: 0, localToken, heartbeatIntervalMs: 15 },
      credentialResolver,
    };
    bridge = startServer(config);
    if (!bridge.listening) await new Promise((resolve) => bridge.once("listening", resolve));
    const port = bridge.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = {
      Authorization: `Bearer ${localToken}`,
      "Content-Type": "application/json",
    };

    async function getJson(pathname) {
      const response = await fetch(`${baseUrl}${pathname}`, { headers });
      const text = await response.text();
      responseBodies.push(text);
      return { response, body: text ? JSON.parse(text) : {} };
    }

    async function post(pathname, body, extraHeaders = {}) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method: "POST",
        headers: { ...headers, ...extraHeaders },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      responseBodies.push(text);
      return { response, text, body: text && !text.startsWith("data:") ? JSON.parse(text) : null };
    }

    const health = await getJson("/health");
    assert.equal(health.response.status, 200);
    assert.deepEqual(health.body, { ok: true });

    const models = await getJson("/v1/models");
    assert.equal(models.response.status, 200);
    assert.deepEqual(models.body.data.map((model) => model.id), ROUTES.map((route) => route.alias));
    assert.deepEqual(models.body.models.map((model) => model.slug), ROUTES.map((route) => route.alias));

    async function assertProtocol(alias, protocol) {
      const route = ROUTES.find((candidate) => candidate.alias === alias);
      const before = fake.requestsFor(alias).length;
      let result;
      if (protocol === "chat") {
        result = await post("/v1/chat/completions", {
          model: alias,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          stream: false,
        });
        assert.equal(result.body.model, alias);
        assert.equal(result.body.choices[0].message.content, "OK");
      } else if (protocol === "responses") {
        result = await post("/v1/responses", { model: alias, input: "Reply with exactly: OK", stream: false });
        assert.equal(result.body.model, alias);
        assert.equal(result.body.output_text, "OK");
      } else {
        result = await post("/v1/messages", {
          model: alias,
          max_tokens: 32,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          stream: false,
        });
        assert.equal(result.body.model, alias);
        assert.equal(result.body.content[0].text, "OK");
      }
      assert.equal(result.response.status, 200);
      const records = fake.requestsFor(alias).slice(before);
      assert.equal(records.length, 1);
      assert.deepEqual(records[0], {
        requestNumber: before + 1,
        model: route.model,
        authorizationMatched: true,
        timestamp: records[0].timestamp,
      });
      assert.equal(Number.isSafeInteger(records[0].timestamp), true);
    }

    for (const route of ROUTES) {
      for (const protocol of ["chat", "responses", "anthropic"]) {
        await assertProtocol(route.alias, protocol);
      }
    }

    const oneDoctor = await probeModel({ ...config, server: { ...config.server, port } }, "coding-fast");
    assert.deepEqual({ alias: oneDoctor.alias, ok: oneDoctor.ok, code: oneDoctor.code }, {
      alias: "coding-fast",
      ok: true,
      code: "OK",
    });
    const allDoctors = await probeAllModels({ ...config, server: { ...config.server, port } });
    assert.deepEqual(allDoctors.map((result) => [result.alias, result.ok]), ROUTES.map((route) => [route.alias, true]));

    const adminDoctor = await post("/admin/api/doctor", { allModels: true }, {
      Origin: baseUrl,
    });
    assert.equal(adminDoctor.response.status, 200);
    assert.deepEqual(adminDoctor.body.results.map((result) => [result.alias, result.ok]), ROUTES.map((route) => [route.alias, true]));

    const liveConfig = { ...config, server: { ...config.server, port } };
    const zcodePlan = planZcodeChange({
      action: "add",
      config: liveConfig,
      state: detectZcodeState({ home: zcodeHome, version: "3.3.6" }),
      managedProviderId: "llm-coding-bridge-e2e",
    });
    assert.equal(zcodePlan.previewOnly, false);
    assert.deepEqual(Object.keys(zcodePlan.expectedProvider.models), ROUTES.map((route) => route.alias));
    const zcodeJson = JSON.stringify(zcodePlan.nextDocument);
    for (const route of ROUTES) assert.doesNotMatch(zcodeJson, new RegExp(route.model));

    const rotatedKey = secret("coding-fast-rotated");
    env.E2E_FAST_KEY = rotatedKey;
    fake.rotateKey("coding-fast", rotatedKey);
    fake.setScript("coding-fast", [{ type: "json", content: "OK" }]);
    const rotationStart = fake.requestsFor("coding-fast").length;
    const rotated = await post("/v1/chat/completions", {
      model: "coding-fast",
      messages: [{ role: "user", content: "rotate" }],
      stream: false,
    });
    assert.equal(rotated.response.status, 200);
    assert.deepEqual(
      fake.requestsFor("coding-fast").slice(rotationStart).map((request) => request.authorizationMatched),
      [false, true]
    );

    async function assertRecovered(alias, steps) {
      const before = fake.requestsFor(alias).length;
      fake.setScript(alias, steps);
      const result = await post("/v1/chat/completions", {
        model: alias,
        messages: [{ role: "user", content: "recover" }],
        stream: false,
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.model, alias);
      assert.equal(result.body.choices[0].message.content, "OK");
      assert.equal(fake.requestsFor(alias).length - before, steps.length);
    }

    await assertRecovered("coding-strong", [
      { type: "status", status: 429, retryAfter: "0" },
      { type: "json", content: "OK" },
    ]);
    await assertRecovered("coding-long", [
      { type: "status", status: 503 },
      { type: "json", content: "OK" },
    ]);
    await assertRecovered("coding-fast", [
      { type: "invalid_json" },
      { type: "json", content: "OK" },
    ]);

    async function assertStreamScenario(alias, steps, expectedText, expectedRequests = steps.length) {
      const before = fake.requestsFor(alias).length;
      fake.setScript(alias, steps);
      const result = await post("/v1/chat/completions", {
        model: alias,
        messages: [{ role: "user", content: "stream" }],
        stream: true,
      });
      assert.equal(result.response.status, 200);
      assert.match(result.text, new RegExp(expectedText));
      assert.match(result.text, /data: \[DONE\]/);
      assert.equal(fake.requestsFor(alias).length - before, expectedRequests);
      return result.text;
    }

    await assertStreamScenario("coding-fast", [{ type: "json", content: "non-sse" }], "non-sse");
    const slowFirst = await assertStreamScenario("coding-strong", [
      { type: "slow_first", delayMs: 55, content: "slow-first" },
    ], "slow-first");
    assert.match(slowFirst, /\"delta\":\{\}/);
    const idleGap = await assertStreamScenario("coding-long", [
      { type: "idle_gap", delayMs: 55, content: "after-idle" },
    ], "after-idle");
    assert.match(idleGap, /\"delta\":\{\}/);
    await assertStreamScenario("coding-fast", [
      { type: "reset" },
      { type: "sse", content: "after-reset" },
    ], "after-reset");

    fake.setScript("coding-strong", [{ type: "reset_after_content", content: "partial-semantic" }]);
    const semanticResetStart = fake.requestsFor("coding-strong").length;
    const semanticReset = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "coding-strong",
        messages: [{ role: "user", content: "do not replay" }],
        stream: true,
      }),
    });
    await assert.rejects(semanticReset.text());
    assert.equal(fake.requestsFor("coding-strong").length - semanticResetStart, 1);

    fake.setScript("coding-long", Array.from({ length: 15 }, () => ({
      type: "status",
      status: 429,
      retryAfter: "0",
    })));
    for (let index = 0; index < 5; index += 1) {
      const failed = await post("/v1/chat/completions", {
        model: "coding-long",
        messages: [{ role: "user", content: "open cooldown" }],
        stream: false,
      });
      assert.equal(failed.response.status, 429);
    }

    const status = await getJson("/admin/api/status");
    assert.equal(status.response.status, 200);
    assert.deepEqual(status.body.routes.map((route) => route.alias), ROUTES.map((route) => route.alias));
    assert.equal(status.body.routes.find((route) => route.alias === "coding-long").health, "open");
    assert.equal(status.body.routes.find((route) => route.alias === "coding-fast").health, "closed");
    await assertProtocol("coding-fast", "chat");

    const events = await getJson("/admin/api/events?afterSequence=0&limit=500");
    assert.equal(events.response.status, 200);
    assert.ok(events.body.events.length > 0);
    assert.equal(events.body.events.every((event) => !event.model || ROUTES.some((route) => route.alias === event.model)), true);

    const publicArtifacts = JSON.stringify({
      responseBodies,
      capturedLogs,
      status: status.body,
      events: events.body,
      normalized,
      zcode: zcodePlan.nextDocument,
    });
    for (const key of [...Object.values(keys), rotatedKey]) {
      assert.doesNotMatch(publicArtifacts, new RegExp(key));
    }
    for (const route of ROUTES) {
      assert.doesNotMatch(JSON.stringify(responseBodies), new RegExp(route.model));
      assert.doesNotMatch(JSON.stringify({ status: status.body, events: events.body }), new RegExp(route.model));
    }
  } finally {
    console.error = originalConsoleError;
    await closeServer(bridge);
    await fake?.close();
    fs.rmSync(zcodeHome, { recursive: true, force: true });
  }

  console.log("multi-model end-to-end tests passed");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
