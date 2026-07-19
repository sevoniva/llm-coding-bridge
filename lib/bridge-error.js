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
const TIMEOUT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"]);
const NETWORK_CODES = new Set(["UND_ERR_SOCKET", "UND_ERR_CONNECT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH"]);
const PROTOCOL_CODES = new Set(["INVALID_UPSTREAM_PROTOCOL", "UPSTREAM_PROTOCOL_ERROR", "UPSTREAM_NON_SSE_RESPONSE", "UPSTREAM_RESPONSE_TOO_LARGE", "UPSTREAM_SSE_EVENT_TOO_LARGE"]);
const MONTHS = new Map(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((month, index) => [month, index]));
const WEEKDAYS = new Map(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => [day, index]));

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
  if (typeof value !== "string" || !Number.isSafeInteger(now)) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    const milliseconds = seconds * 1000;
    return Number.isSafeInteger(seconds) && Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  const imf = /^([A-Z][a-z]{2}), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const rfc850 = /^([A-Z][a-z]+), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const asctime = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2})(?:  (\d)| (\d{2})) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(value);
  let weekday; let day; let month; let year; let hour; let minute; let second;
  if (imf) [, weekday, day, month, year, hour, minute, second] = imf;
  else if (rfc850) {
    const fullWeekday = rfc850[1];
    weekday = fullWeekday.slice(0, 3);
    if (!["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].includes(fullWeekday)) return undefined;
    [, , day, month, year, hour, minute, second] = rfc850;
    year = String(2000 + Number(year));
    if (Number(year) > new Date(now).getUTCFullYear() + 50) year = String(Number(year) - 100);
  } else if (asctime) {
    [, weekday, month, day, , hour, minute, second, year] = asctime;
    day = day || asctime[4];
  } else return undefined;
  const monthIndex = MONTHS.get(month);
  const weekdayIndex = WEEKDAYS.get(weekday);
  const numeric = [day, year, hour, minute, second].map(Number);
  if (monthIndex === undefined || weekdayIndex === undefined || numeric.some((item) => !Number.isInteger(item))) return undefined;
  const [numericDay, numericYear, numericHour, numericMinute, numericSecond] = numeric;
  const date = new Date(0);
  date.setUTCFullYear(numericYear, monthIndex, numericDay);
  date.setUTCHours(numericHour, numericMinute, numericSecond, 0);
  const milliseconds = date.getTime();
  if (!Number.isSafeInteger(milliseconds) || date.getUTCFullYear() !== numericYear || date.getUTCMonth() !== monthIndex || date.getUTCDate() !== numericDay || date.getUTCHours() !== numericHour || date.getUTCMinutes() !== numericMinute || date.getUTCSeconds() !== numericSecond || date.getUTCDay() !== weekdayIndex) return undefined;
  return Math.max(0, milliseconds - now);
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
  const causeCode = safeId(error?.cause?.code);
  if (sourceCode === "UPSTREAM_TIMEOUT" || causeCode === "UPSTREAM_TIMEOUT") {
    return { category: "timeout", retryable: true, scope: "model_route", code: "UPSTREAM_TIMEOUT" };
  }
  if (sourceCode === "CLIENT_CANCELLED" || sourceCode === "ABORT_ERR" || error?.name === "AbortError") {
    return { category: "cancelled", retryable: false, scope: "request", code: "CLIENT_CANCELLED" };
  }
  if (sourceCode === "LOCAL_CONFIGURATION_ERROR" || sourceCode === "CONFIGURATION_ERROR") {
    return { category: "local_config", retryable: false, scope: "local_process", code: "LOCAL_CONFIGURATION_ERROR" };
  }
  if (PROTOCOL_CODES.has(sourceCode) || PROTOCOL_CODES.has(causeCode)) {
    return { category: "protocol", retryable: true, scope: "model_route", code: PROTOCOL_CODES.has(sourceCode) ? sourceCode : causeCode };
  }
  const transportClassification = (code) => {
    if (TIMEOUT_CODES.has(code)) return { category: "timeout", retryable: true, scope: "model_route", code: "UPSTREAM_TIMEOUT" };
    if (NETWORK_CODES.has(code)) return { category: "network", retryable: true, scope: "model_route", code: "UPSTREAM_NETWORK_FAILURE" };
    if (DNS_CODES.has(code)) return { category: "network", retryable: true, scope: "model_route", code: "UPSTREAM_DNS_FAILURE" };
    if (TLS_CODES.has(code)) return { category: "network", retryable: true, scope: "model_route", code: "UPSTREAM_TLS_FAILURE" };
    return undefined;
  };
  const sourceTransport = transportClassification(sourceCode);
  if (sourceTransport) return sourceTransport;
  const causeTransport = transportClassification(causeCode);
  if (causeTransport) return causeTransport;
  if (status >= 500 && status <= 599) {
    return { category: "upstream_5xx", retryable: true, scope: "provider", code: `UPSTREAM_HTTP_${status}` };
  }
  const http = {
    400: ["invalid_request", false, "request"],
    401: ["auth", true, "credential"],
    403: ["auth", false, "credential"],
    404: ["invalid_request", false, "model_route"],
    408: ["timeout", true, "model_route"],
    429: ["rate_limit", true, "model_route"],
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
  if (classification.category === "rate_limit" || status === 408) {
    details.retryAfterMs = parseRetryAfter(retryAfterValue(error), context.now);
  }
  return new BridgeError(details, error);
}

function safeErrorRecord(error) {
  const fields = ["category", "phase", "retryable", "scope", "status", "code", "model", "requestId", "attempt", "elapsedMs", "retryAfterMs"];
  const snapshot = {};
  try {
    if (error && typeof error === "object") {
      for (const key of fields) {
        const descriptor = Object.getOwnPropertyDescriptor(error, key);
        if (descriptor && Object.hasOwn(descriptor, "value")) snapshot[key] = descriptor.value;
      }
    }
  } catch {}
  const own = (key) => snapshot[key];
  const record = {
    name: "BridgeError",
    category: CATEGORIES.has(own("category")) ? own("category") : "network",
    phase: safeId(own("phase")) || "unknown",
    retryable: own("retryable") === true,
    scope: SCOPES.has(own("scope")) ? own("scope") : "model_route",
  };
  const status = safeInteger(own("status"), 100, 599);
  const code = safeId(own("code"));
  const model = safeId(own("model"));
  const requestId = safeId(own("requestId"));
  const attempt = safeInteger(own("attempt"), 0, Number.MAX_SAFE_INTEGER);
  const elapsedMs = safeInteger(own("elapsedMs"), 0, Number.MAX_SAFE_INTEGER);
  const retryAfterMs = safeInteger(own("retryAfterMs"), 0, Number.MAX_SAFE_INTEGER);
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
