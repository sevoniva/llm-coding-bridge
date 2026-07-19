"use strict";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CATEGORIES = new Set([
  "auth",
  "rate_limit",
  "timeout",
  "network",
  "upstream_5xx",
  "protocol",
  "invalid_request",
  "cancelled",
  "local_config",
]);
const SCOPES = new Set(["request", "model_route", "credential", "provider", "local_process"]);
const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NODATA"]);
const TLS_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

function safeId(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return SAFE_ID.test(trimmed) ? trimmed : undefined;
}

function safeInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function responseStatus(error) {
  return safeInteger(error?.status ?? error?.statusCode ?? error?.response?.status, 100, 599);
}

function retryAfterValue(error) {
  const headers = error?.headers || error?.response?.headers;
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get("retry-after");
  return headers["retry-after"] ?? headers["Retry-After"];
}

function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

class BridgeError extends Error {
  constructor(details = {}, rawCause) {
    super("Bridge error");
    this.name = "BridgeError";
    this.category = CATEGORIES.has(details.category) ? details.category : "network";
    this.phase = safeId(details.phase) || "unknown";
    this.retryable = details.retryable === true;
    this.scope = SCOPES.has(details.scope) ? details.scope : "model_route";
    this.status = safeInteger(details.status, 100, 599);
    this.code = safeId(details.code);
    this.model = safeId(details.model);
    this.requestId = safeId(details.requestId);
    this.attempt = safeInteger(details.attempt, 0, Number.MAX_SAFE_INTEGER);
    this.elapsedMs = safeInteger(details.elapsedMs, 0, Number.MAX_SAFE_INTEGER);
    this.retryAfterMs = safeInteger(details.retryAfterMs, 0, Number.MAX_SAFE_INTEGER);
    Object.defineProperty(this, "cause", {
      value: rawCause,
      enumerable: false,
      configurable: true,
    });
  }

  toJSON() {
    return safeErrorRecord(this);
  }
}

function classificationFor(error, status) {
  const sourceCode = safeId(error?.code);
  if (error?.name === "AbortError" || sourceCode === "CLIENT_CANCELLED" || sourceCode === "ABORT_ERR") {
    return { category: "cancelled", retryable: false, scope: "request", code: "CLIENT_CANCELLED" };
  }
  if (sourceCode === "LOCAL_CONFIGURATION_ERROR" || sourceCode === "CONFIGURATION_ERROR") {
    return { category: "local_config", retryable: false, scope: "local_process", code: "LOCAL_CONFIGURATION_ERROR" };
  }
  if (sourceCode === "INVALID_UPSTREAM_PROTOCOL" || sourceCode === "UPSTREAM_PROTOCOL_ERROR") {
    return { category: "protocol", retryable: true, scope: "model_route", code: "INVALID_UPSTREAM_PROTOCOL" };
  }
  if (sourceCode === "UND_ERR_CONNECT_TIMEOUT" || sourceCode === "ETIMEDOUT") {
    return { category: "timeout", retryable: true, scope: "model_route", code: "UPSTREAM_CONNECT_TIMEOUT" };
  }
  if (sourceCode === "ECONNRESET") {
    return { category: "network", retryable: true, scope: "model_route", code: "UPSTREAM_CONNECTION_RESET" };
  }
  if (DNS_CODES.has(sourceCode)) {
    return { category: "network", retryable: true, scope: "model_route", code: "UPSTREAM_DNS_FAILURE" };
  }
  if (TLS_CODES.has(sourceCode)) {
    return { category: "network", retryable: true, scope: "model_route", code: "UPSTREAM_TLS_FAILURE" };
  }
  const http = {
    400: ["invalid_request", false, "request"],
    401: ["auth", true, "credential"],
    403: ["auth", false, "credential"],
    404: ["invalid_request", false, "model_route"],
    408: ["timeout", true, "model_route"],
    429: ["rate_limit", true, "model_route"],
    500: ["upstream_5xx", true, "provider"],
    503: ["upstream_5xx", true, "provider"],
  }[status];
  if (http) {
    return { category: http[0], retryable: http[1], scope: http[2], code: `UPSTREAM_HTTP_${status}` };
  }
  return { category: "network", retryable: false, scope: "model_route", code: "UPSTREAM_UNKNOWN" };
}

function classifyError(error, context = {}) {
  if (error instanceof BridgeError) return error;
  const status = responseStatus(error);
  const classification = classificationFor(error, status);
  const details = {
    ...classification,
    phase: safeId(context.phase) || "unknown",
    status,
    model: safeId(context.model),
    requestId: safeId(context.requestId),
    attempt: safeInteger(context.attempt, 0, Number.MAX_SAFE_INTEGER),
    elapsedMs: safeInteger(context.elapsedMs, 0, Number.MAX_SAFE_INTEGER),
  };
  if (classification.category === "rate_limit") {
    details.retryAfterMs = parseRetryAfter(retryAfterValue(error), context.now);
  }
  return new BridgeError(details, error);
}

function safeErrorRecord(error) {
  const record = {
    name: "BridgeError",
    category: CATEGORIES.has(error?.category) ? error.category : "network",
    phase: safeId(error?.phase) || "unknown",
    retryable: error?.retryable === true,
    scope: SCOPES.has(error?.scope) ? error.scope : "model_route",
  };
  const status = safeInteger(error.status, 100, 599);
  const code = safeId(error.code);
  const model = safeId(error.model);
  const requestId = safeId(error.requestId);
  const attempt = safeInteger(error.attempt, 0, Number.MAX_SAFE_INTEGER);
  const elapsedMs = safeInteger(error.elapsedMs, 0, Number.MAX_SAFE_INTEGER);
  const retryAfterMs = safeInteger(error.retryAfterMs, 0, Number.MAX_SAFE_INTEGER);
  if (status !== undefined) record.status = status;
  if (code) record.code = code;
  if (model) record.model = model;
  if (requestId) record.requestId = requestId;
  if (attempt !== undefined) record.attempt = attempt;
  if (elapsedMs !== undefined) record.elapsedMs = elapsedMs;
  if (retryAfterMs !== undefined) record.retryAfterMs = retryAfterMs;
  return record;
}

module.exports = { BridgeError, classifyError, parseRetryAfter, safeErrorRecord };
