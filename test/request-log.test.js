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

testAllowlistedRequestDiagnostics();
testUntrustedFieldsCannotInjectLogLines();
testStoreBackedLogsUseOnlySafeStoredRecord();
console.log("request-log tests passed");
