"use strict";

const assert = require("node:assert/strict");
const { requestContext, logRequestEvent } = require("../lib/request-log");
const { createEventStore } = require("../lib/event-store");

function captureErrorLine(callback) {
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(String(line));
  try {
    callback();
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  return lines[0];
}

function testAllowlistedRequestDiagnostics() {
  const req = {
    headers: {
      "x-request-id": "req-safe",
      "x-zcode-trace-id": "trace-safe",
      "x-query-id": "query-safe",
      authorization: "Bearer secret-token",
      cookie: "session=secret-cookie",
      "x-upstream-api-key": "secret-upstream-key",
    },
    prompt: "private prompt",
    tools: [{ description: "private tool description" }],
  };
  const context = requestContext(req, "/v1/chat/completions", "glm-5.2");
  const error = Object.assign(new Error("fetch failed secret-token"), {
    code: "UPSTREAM_RESPONSE_FAILED",
    cause: { code: "ECONNRESET", message: "private prompt" },
  });
  const line = captureErrorLine(() => logRequestEvent(context, "upstream_transport_error", {
    status: 502,
    error,
    payload: req,
    responseBody: "secret response body",
  }));

  assert.match(line, /^\[bridge\] /);
  assert.match(line, /req-safe/);
  assert.match(line, /trace-safe/);
  assert.match(line, /query-safe/);
  assert.match(line, /\/v1\/chat\/completions/);
  assert.match(line, /glm-5\.2/);
  assert.match(line, /UPSTREAM_RESPONSE_FAILED/);
  assert.match(line, /ECONNRESET/);
  assert.doesNotMatch(
    line,
    /secret-token|secret-cookie|secret-upstream-key|private prompt|private tool|secret response|fetch failed/,
  );

  const record = JSON.parse(line.slice("[bridge] ".length));
  assert.deepEqual(Object.keys(record).sort(), [
    "causeCode",
    "elapsedMs",
    "errorCode",
    "errorName",
    "model",
    "phase",
    "queryId",
    "requestId",
    "route",
    "status",
    "traceId",
  ]);
}

function testUntrustedFieldsCannotInjectLogLines() {
  const context = requestContext({
    headers: {
      "x-request-id": `safe-prefix\nBearer secret-token-${"x".repeat(500)}`,
      "x-zcode-trace-id": ["trace-safe", "ignored-secret"],
    },
  }, "/v1/chat/completions\nforged", `glm-5.2\n${"y".repeat(500)}`);

  const line = captureErrorLine(() => logRequestEvent(context, "request_start\nforged"));
  assert.equal(line.split("\n").length, 1);
  assert.ok(line.length < 1200, `log line must stay bounded, got ${line.length} bytes`);
  assert.doesNotMatch(line, /secret-token|forged/);
  assert.match(line, /trace-safe/);
}

function testStoreBackedLogsUseOnlySafeStoredRecord() {
  const store = createEventStore({ now: () => 1700000000000 });
  const context = requestContext({ headers: { "x-request-id": "req-safe" } }, "/v1/chat/completions", "safe-model");
  const details = { status: 502 };
  Object.defineProperty(details, "error", {
    enumerable: true,
    get() {
      throw new Error("private error getter must not run");
    },
  });
  const line = captureErrorLine(() => logRequestEvent(context, "upstream_transport_error", details, store));
  const record = JSON.parse(line.slice("[bridge] ".length));
  assert.deepEqual(Object.keys(record).sort(), [
    "elapsedMs", "model", "phase", "requestId", "route", "sequence", "status", "timestamp", "type",
  ]);
  assert.equal(record.sequence, 1);
  assert.equal(record.timestamp, 1700000000000);
  assert.deepEqual(store.snapshot(), [record]);
}

function testAccessorBackedEventStoreIsIgnored() {
  const context = requestContext({}, "/v1/chat/completions", "safe-model");
  let getterCalls = 0;
  const store = {};
  Object.defineProperty(store, "append", {
    get() {
      getterCalls += 1;
      throw new Error("event store getter must not run");
    },
  });
  const line = captureErrorLine(() => assert.doesNotThrow(() => logRequestEvent(context, "request_start", {}, store)));
  assert.equal(getterCalls, 0);
  assert.doesNotMatch(line, /event store getter/);
}

function testProxyEventStoreIsIgnoredWithoutTraps() {
  const context = requestContext({}, "/v1/chat/completions", "safe-model");
  let trapCalls = 0;
  const store = new Proxy({}, {
    get() { trapCalls += 1; throw new Error("proxy get trap"); },
    getOwnPropertyDescriptor() { trapCalls += 1; throw new Error("proxy descriptor trap"); },
    getPrototypeOf() { trapCalls += 1; throw new Error("proxy prototype trap"); },
  });
  const line = captureErrorLine(() => assert.doesNotThrow(() => logRequestEvent(context, "request_start", {}, store)));
  assert.equal(trapCalls, 0);
  assert.doesNotMatch(line, /proxy.*trap/);
}

function testFailedEventStoreAppendFallsBackToSafeRecord() {
  const context = requestContext({ headers: { "x-request-id": "req-safe" } }, "/v1/chat/completions", "safe-model");
  const store = {
    append() {
      throw new Error("private event store failure");
    },
  };
  const line = captureErrorLine(() => assert.doesNotThrow(() => logRequestEvent(context, "request_start", {}, store)));
  const record = JSON.parse(line.slice("[bridge] ".length));
  assert.equal(record.type, "request");
  assert.equal(record.requestId, "req-safe");
  assert.equal(record.sequence, undefined);
  assert.doesNotMatch(line, /private event store failure/);
}

function testHostileStoreResultsNeverReachLogs() {
  const context = requestContext({ headers: { "x-request-id": "req-safe" } }, "/v1/chat/completions", "safe-model");
  const stores = [
    { append() { return { toJSON() { throw new Error("malicious toJSON"); } }; } },
    { append() { return new Proxy({}, { ownKeys() { throw new Error("result proxy trap"); } }); } },
    { append() { const cyclic = {}; cyclic.self = cyclic; return cyclic; } },
    { append() { return undefined; } },
    { append() { return { sequence: 1, timestamp: 1, prompt: "private prompt", authorization: "Bearer secret-token" }; } },
    { append() { return { sequence: 1 }; } },
    { append() { return { sequence: Number.MAX_SAFE_INTEGER + 1, timestamp: Infinity, type: "request" }; } },
  ];
  for (const store of stores) {
    const line = captureErrorLine(() => assert.doesNotThrow(() => logRequestEvent(context, "request_start", {}, store)));
    assert.doesNotMatch(line, /malicious|proxy|private prompt|secret-token|authorization/i);
    const record = JSON.parse(line.slice("[bridge] ".length));
    assert.equal(record.type, "request");
    assert.equal(record.requestId, "req-safe");
  }
}

function testStoreCannotMutateFallbackAndThenThrow() {
  const context = requestContext({ headers: { "x-request-id": "req-safe" } }, "/v1/chat/completions", "safe-model");
  let received;
  const store = {
    append(event) {
      received = event;
      try { event.requestId = "private mutation"; } catch {}
      throw new Error("store failure");
    },
  };
  const line = captureErrorLine(() => assert.doesNotThrow(() => logRequestEvent(context, "request_start", {}, store)));
  assert.ok(Object.isFrozen(received));
  assert.equal(JSON.parse(line.slice("[bridge] ".length)).requestId, "req-safe");
}

function testInvalidStartedAtDoesNotThrowOrEmitElapsedTime() {
  const invalidValues = [Symbol("started"), -1, Infinity, Number.MAX_SAFE_INTEGER + 1];
  for (const startedAt of invalidValues) {
    const context = { requestId: "req-safe", route: "/v1/chat/completions", model: "safe-model", startedAt };
    const line = captureErrorLine(() => assert.doesNotThrow(() => logRequestEvent(context, "request_start", {}, {})));
    assert.equal(JSON.parse(line.slice("[bridge] ".length)).elapsedMs, undefined);
  }
  let getterCalls = 0;
  const context = { requestId: "req-safe", route: "/v1/chat/completions", model: "safe-model" };
  Object.defineProperty(context, "startedAt", { get() { getterCalls += 1; throw new Error("startedAt getter"); } });
  const line = captureErrorLine(() => assert.doesNotThrow(() => logRequestEvent(context, "request_start", {}, {})));
  assert.equal(getterCalls, 0);
  assert.equal(JSON.parse(line.slice("[bridge] ".length)).elapsedMs, undefined);
}

function testProxyContextAndDetailsAreIgnoredWithoutTraps() {
  let trapCalls = 0;
  const traps = {
    get() { trapCalls += 1; throw new Error("unexpected proxy getter"); },
    getOwnPropertyDescriptor() { trapCalls += 1; throw new Error("unexpected proxy descriptor"); },
  };
  const line = captureErrorLine(() => assert.doesNotThrow(() => logRequestEvent(
    new Proxy({}, traps), "request_start", new Proxy({}, traps), {},
  )));
  assert.equal(trapCalls, 0);
  assert.equal(JSON.parse(line.slice("[bridge] ".length)).type, "request");
}

testAllowlistedRequestDiagnostics();
testUntrustedFieldsCannotInjectLogLines();
testStoreBackedLogsUseOnlySafeStoredRecord();
testAccessorBackedEventStoreIsIgnored();
testProxyEventStoreIsIgnoredWithoutTraps();
testFailedEventStoreAppendFallsBackToSafeRecord();
testHostileStoreResultsNeverReachLogs();
testStoreCannotMutateFallbackAndThenThrow();
testInvalidStartedAtDoesNotThrowOrEmitElapsedTime();
testProxyContextAndDetailsAreIgnoredWithoutTraps();
console.log("request-log tests passed");
