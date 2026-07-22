"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { Readable } = require("node:stream");
const path = require("node:path");
const { buildAdminStatus } = require("../lib/admin-status");
const { createAdminHandler, isLoopbackPeer } = require("../lib/admin");
const { probeModel, probeAllModels } = require("../lib/doctor");
const { zcodeVerificationStatus } = require("../lib/zcode-client");

const credentialReferences = [];
const runtime = {
  config: {
    path: "/tmp/bridge/config.json",
    routes: [{
      alias: "coding-fast",
      model: "provider-model-id-a",
      credentialRef: "credential-fast",
      capabilities: {
        contextWindow: 128000,
        inputModalities: ["text", "image"],
        reasoning: true,
        privateDescription: "prompt-secret",
      },
      baseUrl: "https://private.example/v1",
      credential: { key: "key-secret" },
    }],
  },
  credentialResolver: {
    availability(reference) {
      credentialReferences.push(reference);
      return true;
    },
  },
  healthRegistry: {
    snapshot() {
      return [{
        alias: "coding-fast",
        health: "closed",
        consecutiveFailures: 0,
        cooldownUntil: null,
        halfOpenProbeActive: false,
        lastSuccessAt: 1000,
        rawError: "response-secret",
      }];
    },
  },
  eventStore: {
    snapshot() {
      return [{ type: "attempt", prompt: "event-secret" }];
    },
  },
  localToken: "local-secret",
};

const zcode = zcodeVerificationStatus({
  version: "3.8.1",
  supported: true,
  previewOnly: false,
  managedProviderPresent: true,
  aliasCount: 2,
  privateMode: true,
  lastVerifiedAt: 1500,
  providers: [{ apiKey: "zcode-secret" }],
});

assert.deepEqual(zcode, {
  version: "3.8.1",
  supported: true,
  previewOnly: false,
  managedProviderPresent: true,
  aliasCount: 2,
  privateMode: true,
  lastVerifiedAt: 1500,
});
assert.equal(Object.isFrozen(zcode), true);

const snapshot = buildAdminStatus(runtime, {
  version: "0.7.0",
  startedAt: 500,
  now: () => 2000,
  zcode,
});

assert.deepEqual(snapshot, {
  version: "0.7.0",
  uptimeMs: 1500,
  configPath: path.resolve("/tmp/bridge/config.json"),
  routes: [{
    alias: "coding-fast",
    capabilities: {
      contextWindow: 128000,
      inputModalities: ["text", "image"],
      reasoning: true,
    },
    credentialAvailable: true,
    health: "closed",
    consecutiveFailures: 0,
    cooldownUntil: null,
    halfOpenProbeActive: false,
    lastSuccessAt: 1000,
  }],
  zcode,
});
assert.deepEqual(credentialReferences, ["credential-fast"]);
assert.equal(Object.isFrozen(snapshot), true);
assert.equal(Object.isFrozen(snapshot.routes), true);
assert.equal(Object.isFrozen(snapshot.routes[0]), true);
assert.equal(Object.isFrozen(snapshot.routes[0].capabilities), true);
assert.doesNotMatch(JSON.stringify(snapshot), /prompt-secret|response-secret|event-secret|key-secret|local-secret|private\.example|zcode-secret/);

const unavailable = buildAdminStatus({
  config: { routes: [{ alias: "legacy", capabilities: {} }] },
  credentialResolver: null,
  healthRegistry: { snapshot: () => [] },
}, { version: "0.7.0", startedAt: 2000, now: () => 1000 });
assert.equal(unavailable.uptimeMs, 0);
assert.equal(unavailable.routes[0].credentialAvailable, false);
assert.equal(unavailable.routes[0].health, "closed");

function adminRequest({
  method = "GET",
  pathname = "/admin/api/status",
  remoteAddress = "127.0.0.1",
  headers = {},
  body = "",
} = {}) {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  request.method = method;
  request.url = pathname;
  request.headers = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  request.socket = { remoteAddress };
  return request;
}

function adminResponse() {
  return {
    statusCode: null,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value);
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(chunk = "") {
      this.body += String(chunk);
      this.writableEnded = true;
    },
  };
}

async function invoke(handler, requestOptions) {
  const req = adminRequest(requestOptions);
  const res = adminResponse();
  const handled = await handler(req, res, new URL(req.url, "http://127.0.0.1").pathname);
  return {
    handled,
    status: res.statusCode,
    headers: res.headers,
    body: res.body ? JSON.parse(res.body) : null,
  };
}

async function testAdminBoundary() {
  for (const address of ["127.0.0.1", "127.42.0.7", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackPeer(address), true, address);
  }
  for (const address of [undefined, "", "localhost", "0.0.0.0", "192.0.2.1", "::", "::ffff:192.0.2.1"]) {
    assert.equal(isLoopbackPeer(address), false, String(address));
  }

  const events = [{ sequence: 2, timestamp: 1900, type: "attempt", phase: "start" }];
  const handler = createAdminHandler({
    runtime: {
      ...runtime,
      eventStore: {
        snapshot(options) {
          assert.deepEqual(options, { afterSequence: 1, limit: 5 });
          return events;
        },
      },
    },
    localToken: "admin-local-token",
    startedAt: 500,
    now: () => 2000,
    runDoctor: async (request) => ({
      alias: request.model,
      ok: true,
      category: "success",
      code: "OK",
      elapsedMs: 1,
      raw: "response-secret",
    }),
  });

  const unknown = await invoke(handler, { pathname: "/admin/not-allowed" });
  assert.equal(unknown.handled, false);
  assert.equal(unknown.status, null);

  for (const pathname of ["/admin", "/admin/admin.css", "/admin/admin.js", "/admin/api/status", "/admin/api/events", "/admin/api/doctor"]) {
    const denied = await invoke(handler, {
      method: pathname === "/admin/api/doctor" ? "POST" : "GET",
      pathname,
      remoteAddress: "192.0.2.10",
      headers: {
        authorization: "Bearer admin-local-token",
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: pathname === "/admin/api/doctor" ? "{}" : "",
    });
    assert.equal(denied.handled, true);
    assert.equal(denied.status, 403, pathname);
    assert.equal(denied.body.error.type, "admin_loopback_required");
  }

  const status = await invoke(handler, {
    headers: { "x-forwarded-for": "203.0.113.2" },
  });
  assert.equal(status.status, 200);
  assert.equal(status.body.version, require("../package.json").version);
  assert.equal(status.headers["cache-control"], "no-store");
  assert.equal(status.headers["x-content-type-options"], "nosniff");
  assert.equal(status.headers["referrer-policy"], "no-referrer");
  assert.match(status.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(status.headers["access-control-allow-origin"], undefined);
  assert.doesNotMatch(JSON.stringify(status.body), /admin-local-token|key-secret|event-secret/);

  const eventResponse = await invoke(handler, { pathname: "/admin/api/events?afterSequence=1&limit=5" });
  assert.equal(eventResponse.status, 200);
  assert.deepEqual(eventResponse.body, { events, nextSequence: 2 });

  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await invoke(handler, { method, pathname: "/admin/api/status" });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, "GET");
  }

  const noTokenHandler = createAdminHandler({ runtime, startedAt: 500, now: () => 2000 });
  const noToken = await invoke(noTokenHandler, {
    method: "POST",
    pathname: "/admin/api/doctor",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "coding-fast" }),
  });
  assert.equal(noToken.status, 409);
  assert.equal(noToken.body.error.type, "admin_auth_not_configured");

  for (const authorization of [undefined, "Bearer wrong-token"]) {
    const response = await invoke(handler, {
      method: "POST",
      pathname: "/admin/api/doctor",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ model: "coding-fast" }),
    });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.type, "admin_auth_error");
  }

  const badOrigin = await invoke(handler, {
    method: "POST",
    pathname: "/admin/api/doctor",
    headers: {
      authorization: "Bearer admin-local-token",
      "content-type": "application/json",
      origin: "https://example.com",
    },
    body: JSON.stringify({ model: "coding-fast" }),
  });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.body.error.type, "admin_origin_not_allowed");

  const missingType = await invoke(handler, {
    method: "POST",
    pathname: "/admin/api/doctor",
    headers: { authorization: "Bearer admin-local-token" },
    body: JSON.stringify({ model: "coding-fast" }),
  });
  assert.equal(missingType.status, 415);
  assert.equal(missingType.body.error.type, "admin_unsupported_media_type");

  const oversized = await invoke(handler, {
    method: "POST",
    pathname: "/admin/api/doctor",
    headers: { authorization: "Bearer admin-local-token", "content-type": "application/json" },
    body: JSON.stringify({ model: "x".repeat(17 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.type, "admin_payload_too_large");

  const accepted = await invoke(handler, {
    method: "POST",
    pathname: "/admin/api/doctor",
    headers: {
      authorization: "Bearer admin-local-token",
      "content-type": "application/json; charset=utf-8",
      origin: "http://127.0.0.1:37629",
    },
    body: JSON.stringify({ model: "coding-fast" }),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, {
    alias: "coding-fast",
    ok: true,
    category: "success",
    code: "OK",
    elapsedMs: 1,
  });
}

async function testDoctorActions() {
  const safeConfig = {
    routes: [
      { alias: "coding-fast", model: "provider-model-id-a", credentialRef: "credential-fast" },
      { alias: "coding-long", model: "provider-model-id-b", credentialRef: "credential-long" },
    ],
    credentialResolver: { resolve: () => "credential-secret", invalidate() {} },
  };
  const calls = [];
  const times = [1000, 1025];
  const success = await probeModel(safeConfig, "coding-fast", {
    now: () => times.shift(),
    fetchJson: async (route, payload) => {
      calls.push({ route, payload });
      return {
        choices: [{ message: { content: "OK" } }],
        providerBody: "response-secret",
      };
    },
  });
  assert.deepEqual(success, {
    alias: "coding-fast",
    ok: true,
    category: "success",
    code: "OK",
    elapsedMs: 25,
  });
  assert.equal(calls[0].route.credentialResolver, safeConfig.credentialResolver);
  assert.equal(calls[0].payload.model, "provider-model-id-a");
  assert.doesNotMatch(JSON.stringify(success), /credential-secret|response-secret|provider-model-id/);

  const failed = await probeModel(safeConfig, "coding-fast", {
    now: (() => {
      const values = [2000, 2040];
      return () => values.shift();
    })(),
    fetchJson: async () => {
      const error = new Error("response-secret");
      error.status = 429;
      throw error;
    },
  });
  assert.deepEqual(failed, {
    alias: "coding-fast",
    ok: false,
    category: "rate_limit",
    code: "UPSTREAM_HTTP_429",
    elapsedMs: 40,
  });
  assert.doesNotMatch(JSON.stringify(failed), /response-secret/);

  const statusServer = http.createServer((_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "response-secret" }));
  });
  await new Promise((resolve, reject) => {
    statusServer.once("error", reject);
    statusServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = statusServer.address().port;
    const liveFailure = await probeModel({
      ...safeConfig,
      routes: safeConfig.routes.map((route) => ({ ...route, baseUrl: `http://127.0.0.1:${port}/v1` })),
    }, "coding-fast");
    assert.equal(liveFailure.category, "rate_limit");
    assert.equal(liveFailure.code, "UPSTREAM_HTTP_429");
    assert.doesNotMatch(JSON.stringify(liveFailure), /response-secret/);
  } finally {
    await new Promise((resolve) => statusServer.close(resolve));
  }

  const unexpected = await probeModel(safeConfig, "coding-fast", {
    now: () => 3000,
    fetchJson: async () => ({ choices: [{ message: { content: "not the probe token response-secret" } }] }),
  });
  assert.deepEqual(unexpected, {
    alias: "coding-fast",
    ok: false,
    category: "protocol",
    code: "DOCTOR_UNEXPECTED_RESPONSE",
    elapsedMs: 0,
  });
  assert.doesNotMatch(JSON.stringify(unexpected), /response-secret|not the probe/);

  const order = [];
  const all = await probeAllModels(safeConfig, {
    now: () => 4000,
    fetchJson: async (route) => {
      order.push(route.alias);
      return { choices: [{ message: { content: "OK" } }] };
    },
  });
  assert.deepEqual(order, ["coding-fast", "coding-long"]);
  assert.deepEqual(all.map((result) => result.alias), order);
  assert.equal(all.every((result) => result.ok), true);

  const invalidBodies = [
    [{}, 400, "admin_invalid_doctor_request"],
    [{ model: "coding-fast", allModels: true }, 400, "admin_invalid_doctor_request"],
    [{ model: "coding-fast", extra: true }, 400, "admin_invalid_doctor_request"],
    [{ allModels: false }, 400, "admin_invalid_doctor_request"],
    [["coding-fast"], 400, "admin_invalid_doctor_request"],
    [{ model: "missing-alias" }, 404, "admin_unknown_model"],
  ];
  const actionEvents = [];
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  const actionRuntime = {
    config: safeConfig,
    credentialResolver: safeConfig.credentialResolver,
    healthRegistry: { snapshot: () => [] },
    eventStore: {
      snapshot: () => [],
      append(event) {
        actionEvents.push(event);
      },
    },
  };
  const actionHandler = createAdminHandler({
    runtime: actionRuntime,
    localToken: "admin-local-token",
    now: () => 5000,
    runDoctor: async (request) => {
      if (request.model === "coding-fast") {
        firstStarted();
        await blocked;
      }
      return request.allModels
        ? { results: safeConfig.routes.map((route) => ({ alias: route.alias, ok: true, category: "success", code: "OK", elapsedMs: 2 })) }
        : { alias: request.model, ok: true, category: "success", code: "OK", elapsedMs: 2, raw: "response-secret" };
    },
  });
  const actionRequest = (body) => ({
    method: "POST",
    pathname: "/admin/api/doctor",
    headers: { authorization: "Bearer admin-local-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  for (const [body, status, type] of invalidBodies) {
    const response = await invoke(actionHandler, actionRequest(body));
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(response.body.error.type, type);
  }
  const invalidJson = await invoke(actionHandler, {
    ...actionRequest({}),
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.error.type, "admin_invalid_json");

  const first = invoke(actionHandler, actionRequest({ model: "coding-fast" }));
  await firstStarted;
  const duplicate = await invoke(actionHandler, actionRequest({ model: "coding-fast" }));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.type, "admin_doctor_busy");
  const overlappingAll = await invoke(actionHandler, actionRequest({ allModels: true }));
  assert.equal(overlappingAll.status, 409);
  assert.equal(overlappingAll.body.error.type, "admin_doctor_busy");
  const independent = await invoke(actionHandler, actionRequest({ model: "coding-long" }));
  assert.equal(independent.status, 200);
  assert.equal(independent.body.alias, "coding-long");
  releaseFirst();
  const completed = await first;
  assert.equal(completed.status, 200);
  assert.deepEqual(completed.body, {
    alias: "coding-fast",
    ok: true,
    category: "success",
    code: "OK",
    elapsedMs: 2,
  });
  assert.doesNotMatch(JSON.stringify(completed.body), /response-secret/);
  assert.deepEqual(actionEvents.map((event) => [event.phase, event.model, event.outcome]), [
    ["doctor_start", "coding-fast", undefined],
    ["doctor_start", "coding-long", undefined],
    ["doctor_result", "coding-long", "success"],
    ["doctor_result", "coding-fast", "success"],
  ]);
  assert.doesNotMatch(JSON.stringify(actionEvents), /response-secret|credential-secret/);
}

Promise.all([testAdminBoundary(), testDoctorActions()])
  .then(() => console.log("admin tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
