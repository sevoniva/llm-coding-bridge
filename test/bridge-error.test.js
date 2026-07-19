"use strict";

const assert = require("node:assert/strict");
const {
  BridgeError,
  classifyError,
  parseRetryAfter,
  safeErrorRecord,
} = require("../lib/bridge-error");

function classify(error, overrides = {}) {
  return classifyError(error, {
    phase: "waiting_first_content",
    model: "coding-fast",
    requestId: "req-1",
    attempt: 1,
    elapsedMs: 125,
    ...overrides,
  });
}

function testClassifierTable() {
  const cases = [
    ["AbortError is cancelled", Object.assign(new Error("aborted"), { name: "AbortError" }), "cancelled", false, "request"],
    ["UND_ERR_CONNECT_TIMEOUT is timeout", Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }), "timeout", true, "model_route"],
    ["ECONNRESET is network", Object.assign(new Error("reset"), { code: "ECONNRESET" }), "network", true, "model_route"],
    ["DNS errors are network", Object.assign(new Error("dns"), { code: "ENOTFOUND" }), "network", true, "model_route"],
    ["temporary DNS errors are network", Object.assign(new Error("dns"), { code: "EAI_AGAIN" }), "network", true, "model_route"],
    ["TLS errors are network", Object.assign(new Error("tls"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), "network", true, "model_route"],
    ["certificate TLS errors are network", Object.assign(new Error("tls"), { code: "CERT_HAS_EXPIRED" }), "network", true, "model_route"],
    ["HTTP 400 is invalid request", { status: 400 }, "invalid_request", false, "request"],
    ["HTTP 401 is auth", { status: 401 }, "auth", true, "credential"],
    ["HTTP 403 is auth", { status: 403 }, "auth", false, "credential"],
    ["HTTP 404 is invalid request", { status: 404 }, "invalid_request", false, "model_route"],
    ["HTTP 408 is timeout", { status: 408 }, "timeout", true, "model_route"],
    ["HTTP 429 is rate limited", { status: 429, headers: { "retry-after": "2" } }, "rate_limit", true, "model_route"],
    ["HTTP 500 is upstream 5xx", { status: 500 }, "upstream_5xx", true, "provider"],
    ["HTTP 503 is upstream 5xx", { status: 503 }, "upstream_5xx", true, "provider"],
    ["invalid HTTP 200 protocol data is protocol", { status: 200, code: "INVALID_UPSTREAM_PROTOCOL" }, "protocol", true, "model_route"],
    ["client cancellation is cancelled", { code: "CLIENT_CANCELLED" }, "cancelled", false, "request"],
    ["local configuration errors are local config", { code: "LOCAL_CONFIGURATION_ERROR" }, "local_config", false, "local_process"],
  ];

  for (const [name, error, category, retryable, scope] of cases) {
    const result = classify(error);
    assert.ok(result instanceof BridgeError, name);
    assert.equal(result.category, category, name);
    assert.equal(result.retryable, retryable, name);
    assert.equal(result.scope, scope, name);
  }
}

function testSafeSerialization() {
  const classified = classify({ status: 429, headers: { "retry-after": "2" } });
  assert.deepEqual(JSON.parse(JSON.stringify(classified)), {
    name: "BridgeError",
    category: "rate_limit",
    phase: "waiting_first_content",
    retryable: true,
    scope: "model_route",
    status: 429,
    code: "UPSTREAM_HTTP_429",
    model: "coding-fast",
    requestId: "req-1",
    attempt: 1,
    elapsedMs: 125,
    retryAfterMs: 2000,
  });
}

function testSerializationExcludesRawErrorData() {
  const raw = Object.assign(new Error("authorization: Bearer secret-token"), {
    code: "ECONNRESET",
    authorization: "Bearer secret-token",
    prompt: "private prompt",
    responseBody: "private response body",
    cause: new Error("nested secret message"),
  });
  const serialized = JSON.stringify(classify(raw));
  assert.doesNotMatch(serialized, /secret-token|private prompt|private response body|nested secret message/);
  assert.deepEqual(safeErrorRecord(classify(raw)), JSON.parse(serialized));
  assert.equal(Object.getOwnPropertyDescriptor(classify(raw), "cause").enumerable, false);
}

function testRetryAfterParsing() {
  assert.equal(parseRetryAfter("2", 0), 2000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:03 GMT", 0), 3000);
  assert.equal(parseRetryAfter("invalid", 0), undefined);
}

testClassifierTable();
testSafeSerialization();
testSerializationExcludesRawErrorData();
testRetryAfterParsing();
console.log("bridge error tests passed");
