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
    ["explicit client AbortError is cancelled", Object.assign(new Error("aborted"), { name: "AbortError", code: "CLIENT_CANCELLED" }), "cancelled", false, "request"],
    ["upstream timeout AbortError is timeout", Object.assign(new Error("aborted upstream"), { name: "AbortError", code: "UPSTREAM_TIMEOUT" }), "timeout", true, "model_route"],
    ["UND_ERR_CONNECT_TIMEOUT is timeout", Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }), "timeout", true, "model_route"],
    ["ECONNRESET is network", Object.assign(new Error("reset"), { code: "ECONNRESET" }), "network", true, "model_route"],
    ["DNS errors are network", Object.assign(new Error("dns"), { code: "ENOTFOUND" }), "network", true, "model_route"],
    ["temporary DNS errors are network", Object.assign(new Error("dns"), { code: "EAI_AGAIN" }), "network", true, "model_route"],
    ["TLS errors are network", Object.assign(new Error("tls"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }), "network", true, "model_route"],
    ["certificate TLS errors are network", Object.assign(new Error("tls"), { code: "CERT_HAS_EXPIRED" }), "network", true, "model_route"],
    ["nested connect timeout is timeout", { code: "UPSTREAM_RESPONSE_FAILED", cause: Object.assign(new Error("nested timeout secret"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }, "timeout", true, "model_route"],
    ["nested connection reset is network", { code: "UPSTREAM_RESPONSE_FAILED", cause: Object.assign(new Error("nested reset secret"), { code: "ECONNRESET" }) }, "network", true, "model_route"],
    ["nested DNS errors are network", { code: "UPSTREAM_RESPONSE_FAILED", cause: Object.assign(new Error("nested dns secret"), { code: "ENOTFOUND" }) }, "network", true, "model_route"],
    ["nested TLS errors are network", { code: "UPSTREAM_RESPONSE_FAILED", cause: Object.assign(new Error("nested tls secret"), { code: "CERT_HAS_EXPIRED" }) }, "network", true, "model_route"],
    ["HTTP 400 is invalid request", { status: 400 }, "invalid_request", false, "request"],
    ["HTTP 401 is auth", { status: 401 }, "auth", true, "credential"],
    ["HTTP 403 is auth", { status: 403 }, "auth", false, "credential"],
    ["HTTP 404 is invalid request", { status: 404 }, "invalid_request", false, "model_route"],
    ["HTTP 408 is timeout", { status: 408 }, "timeout", true, "model_route"],
    ["HTTP 429 is rate limited", { status: 429, headers: { "retry-after": "2" } }, "rate_limit", true, "model_route"],
    ["HTTP 500 is upstream 5xx", { status: 500 }, "upstream_5xx", true, "provider"],
    ["HTTP 502 is upstream 5xx", { status: 502 }, "upstream_5xx", true, "provider"],
    ["HTTP 503 is upstream 5xx", { status: 503 }, "upstream_5xx", true, "provider"],
    ["HTTP 504 is upstream 5xx", { status: 504 }, "upstream_5xx", true, "provider"],
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

function testNestedCauseSerializationExcludesMessages() {
  const raw = {
    cause: Object.assign(new Error("nested transport secret"), { code: "ECONNRESET" }),
  };
  const serialized = JSON.stringify(classify(raw));
  assert.doesNotMatch(serialized, /nested transport secret/);
  assert.match(serialized, /UPSTREAM_CONNECTION_RESET/);
}

function testRetryAfterParsing() {
  assert.equal(parseRetryAfter("2", 0), 2000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:03 GMT", 0), 3000);
  assert.equal(parseRetryAfter("invalid", 0), undefined);
}

function testTimeoutRetryAfterPropagation() {
  const classified = classify({ status: 408, headers: { "retry-after": "3" } });
  assert.equal(classified.retryAfterMs, 3000);
}

testClassifierTable();
testSafeSerialization();
testSerializationExcludesRawErrorData();
testNestedCauseSerializationExcludesMessages();
testRetryAfterParsing();
testTimeoutRetryAfterPropagation();
console.log("bridge error tests passed");
