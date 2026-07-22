"use strict";

const DEFAULT_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10000,
  maxCumulativeDelayMs: 30000,
  maxRetryAfterMs: 120000,
});

function decision(retry, delayMs, refreshCredential, reason) {
  return Object.freeze({ retry, delayMs, refreshCredential, reason });
}

function requireInteger(value, minimum, name) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be a safe integer.`);
  return value;
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") throw new TypeError("policy must be an object.");
  return {
    maxAttempts: requireInteger(policy.maxAttempts, 1, "policy.maxAttempts"),
    baseDelayMs: requireInteger(policy.baseDelayMs, 0, "policy.baseDelayMs"),
    maxDelayMs: requireInteger(policy.maxDelayMs, 0, "policy.maxDelayMs"),
    maxCumulativeDelayMs: requireInteger(policy.maxCumulativeDelayMs, 0, "policy.maxCumulativeDelayMs"),
    maxRetryAfterMs: requireInteger(policy.maxRetryAfterMs, 0, "policy.maxRetryAfterMs"),
  };
}

function decideRetry(options = {}) {
  const {
    error,
    attempt,
    semanticContentStarted,
    cumulativeDelayMs,
    credentialRefreshAttempted = false,
    policy = DEFAULT_RETRY_POLICY,
    random = Math.random,
  } = options;
  const limits = validatePolicy(policy);
  requireInteger(attempt, 1, "attempt");
  requireInteger(cumulativeDelayMs, 0, "cumulativeDelayMs");
  if (!error || typeof error !== "object") throw new TypeError("error must be an object.");
  if (typeof random !== "function") throw new TypeError("random must be a function.");

  if (semanticContentStarted) return decision(false, 0, false, "semantic_content_started");
  if (attempt >= limits.maxAttempts) return decision(false, 0, false, "attempt_limit_reached");
  if ([400, 403, 404].includes(error.status)) return decision(false, 0, false, "status_not_retryable");
  if (error.category === "cancelled" || error.category === "local_config") {
    return decision(false, 0, false, "category_not_retryable");
  }
  if (error.status === 401) {
    return credentialRefreshAttempted
      ? decision(false, 0, false, "credential_refresh_exhausted")
      : decision(true, 0, true, "credential_refresh");
  }
  if (error.retryable !== true) return decision(false, 0, false, "not_retryable");

  const remainingDelayMs = limits.maxCumulativeDelayMs - cumulativeDelayMs;
  if (remainingDelayMs < 0) return decision(false, 0, false, "wait_budget_exhausted");
  if (error.retryAfterMs !== undefined) {
    if (!Number.isSafeInteger(error.retryAfterMs) || error.retryAfterMs < 0 || error.retryAfterMs > limits.maxRetryAfterMs) {
      return decision(false, 0, false, "retry_after_exceeds_cap");
    }
    return error.retryAfterMs <= remainingDelayMs
      ? decision(true, error.retryAfterMs, false, "retryable_pre_content")
      : decision(false, 0, false, "wait_budget_exhausted");
  }

  const sample = random();
  if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new TypeError("random must return a number from 0 through less than 1.");
  }
  const rawCap = Math.min(limits.maxDelayMs, limits.baseDelayMs * (2 ** (attempt - 1)));
  const delayMs = Math.floor(sample * (rawCap + 1));
  return delayMs <= remainingDelayMs
    ? decision(true, delayMs, false, "retryable_pre_content")
    : decision(false, 0, false, "wait_budget_exhausted");
}

module.exports = { DEFAULT_RETRY_POLICY, decideRetry };
