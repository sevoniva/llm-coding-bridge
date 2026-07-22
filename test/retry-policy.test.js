"use strict";

const assert = require("node:assert/strict");
const { BridgeError } = require("../lib/bridge-error");
const { DEFAULT_RETRY_POLICY, decideRetry } = require("../lib/retry-policy");

function error(details) {
  return new BridgeError(details);
}

function decide(overrides = {}) {
  return decideRetry({
    error: error({ category: "network", retryable: true }),
    attempt: 1,
    semanticContentStarted: false,
    cumulativeDelayMs: 0,
    credentialRefreshAttempted: false,
    policy: DEFAULT_RETRY_POLICY,
    random: () => 0.5,
    ...overrides,
  });
}

assert.deepEqual(DEFAULT_RETRY_POLICY, {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10000,
  maxCumulativeDelayMs: 30000,
  maxRetryAfterMs: 120000,
});
assert.equal(Object.isFrozen(DEFAULT_RETRY_POLICY), true);

assert.deepEqual(decide(), {
  retry: true,
  delayMs: 250,
  refreshCredential: false,
  reason: "retryable_pre_content",
});
assert.equal(decide({ attempt: 2 }).delayMs, 500);
assert.deepEqual(decide({ attempt: 3 }), {
  retry: false,
  delayMs: 0,
  refreshCredential: false,
  reason: "attempt_limit_reached",
});

assert.equal(decide({ semanticContentStarted: true }).reason, "semantic_content_started");
assert.equal(decide({ error: error({ category: "network", retryable: false }) }).reason, "not_retryable");

for (const status of [400, 403, 404]) {
  assert.deepEqual(decide({ error: error({ category: "invalid_request", retryable: true, status }) }), {
    retry: false,
    delayMs: 0,
    refreshCredential: false,
    reason: "status_not_retryable",
  });
}

for (const category of ["cancelled", "local_config"]) {
  assert.equal(decide({ error: error({ category, retryable: true }) }).reason, "category_not_retryable");
}

assert.deepEqual(decide({ error: error({ category: "auth", retryable: false, status: 401 }) }), {
  retry: true,
  delayMs: 0,
  refreshCredential: true,
  reason: "credential_refresh",
});
assert.equal(decide({
  error: error({ category: "auth", retryable: false, status: 401 }),
  credentialRefreshAttempted: true,
}).reason, "credential_refresh_exhausted");

assert.equal(decide({
  error: error({ category: "rate_limit", retryable: true, status: 429, retryAfterMs: 2000 }),
}).delayMs, 2000);
assert.equal(decide({
  error: error({ category: "rate_limit", retryable: true, status: 429, retryAfterMs: 120001 }),
}).reason, "retry_after_exceeds_cap");
assert.equal(decide({
  error: error({ category: "rate_limit", retryable: true, status: 429, retryAfterMs: 2000 }),
  cumulativeDelayMs: 29000,
}).reason, "wait_budget_exhausted");
assert.equal(decide({ cumulativeDelayMs: 29900, random: () => 0.5 }).reason, "wait_budget_exhausted");

assert.throws(() => decide({ attempt: 0 }), /attempt/i);
assert.throws(() => decide({ random: () => 1 }), /random/i);

console.log("retry policy tests passed");
