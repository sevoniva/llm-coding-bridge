"use strict";

const MAX_FIELD_LENGTH = 160;
const SAFE_FIELD = /^[A-Za-z0-9/][A-Za-z0-9._:/-]*$/;

function firstHeader(req, name) {
  const value = req?.headers?.[name];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function safeField(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD_LENGTH || !SAFE_FIELD.test(trimmed)) return "";
  return trimmed;
}

function requestContext(req, route, model) {
  return {
    requestId: safeField(firstHeader(req, "x-request-id")),
    traceId: safeField(firstHeader(req, "x-zcode-trace-id")),
    queryId: safeField(firstHeader(req, "x-query-id")),
    route: safeField(route),
    model: safeField(model),
    startedAt: Date.now(),
  };
}

function logRequestEvent(context, phase, details = {}) {
  if (!context) return;
  const record = {
    phase: safeField(phase),
    requestId: safeField(context.requestId),
    traceId: safeField(context.traceId),
    queryId: safeField(context.queryId),
    route: safeField(context.route),
    model: safeField(context.model),
    elapsedMs: Math.max(0, Date.now() - Number(context.startedAt || Date.now())),
  };
  if (Number.isInteger(details.status) && details.status >= 100 && details.status <= 599) {
    record.status = details.status;
  }
  const errorName = safeField(details.error?.name);
  const errorCode = safeField(details.error?.code);
  const causeCode = safeField(details.error?.cause?.code);
  if (errorName) record.errorName = errorName;
  if (errorCode) record.errorCode = errorCode;
  if (causeCode) record.causeCode = causeCode;
  console.error(`[bridge] ${JSON.stringify(record)}`);
}

module.exports = { requestContext, logRequestEvent };
