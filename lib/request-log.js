"use strict";

const { types } = require("node:util");
const { sanitizeEventRecord } = require("./event-store");

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

function safeDataValue(value, key) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeOwnAppend(value) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "append");
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return undefined;
    return types.isProxy(descriptor.value) ? undefined : descriptor.value;
  } catch {
    return undefined;
  }
}

function safeElapsed(startedAt) {
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) return undefined;
  const now = Date.now();
  if (!Number.isSafeInteger(now) || now < 0) return undefined;
  const elapsed = Math.max(0, now - startedAt);
  return Number.isSafeInteger(elapsed) ? elapsed : undefined;
}

function matchesStoredFallback(record, fallback) {
  if (!record || !Number.isSafeInteger(record.sequence) || record.sequence < 1 ||
    !Number.isSafeInteger(record.timestamp) || record.timestamp < 0) return false;
  const fallbackKeys = Object.keys(fallback).sort();
  const recordKeys = Object.keys(record).filter((key) => key !== "sequence" && key !== "timestamp").sort();
  if (fallbackKeys.length !== recordKeys.length) return false;
  return fallbackKeys.every((key, index) => key === recordKeys[index] && Object.is(fallback[key], record[key]));
}

function hasExactStoredShape(rawRecord, fallback) {
  if (!rawRecord || typeof rawRecord !== "object" || types.isProxy(rawRecord)) return false;
  const expectedKeys = new Set([...Object.keys(fallback), "sequence", "timestamp"]);
  try {
    const keys = Reflect.ownKeys(rawRecord);
    if (keys.length !== expectedKeys.size) return false;
    for (const key of keys) {
      if (typeof key !== "string" || !expectedKeys.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(rawRecord, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
    }
    return true;
  } catch {
    return false;
  }
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

function logRequestEvent(context, phase, details = {}, eventStore) {
  if (!context) return;
  if (eventStore) {
    const requestId = safeDataValue(context, "requestId");
    const traceId = safeDataValue(context, "traceId");
    const route = safeDataValue(context, "route");
    const model = safeDataValue(context, "model");
    const startedAt = safeDataValue(context, "startedAt");
    const status = safeDataValue(details, "status");
    const error = safeDataValue(details, "error");
    const errorCode = safeField(safeDataValue(error, "code"));
    const cause = safeDataValue(error, "cause");
    const causeCode = safeField(safeDataValue(cause, "code"));
    const event = {
      type: "request",
    };
    const elapsedMs = safeElapsed(startedAt);
    if (elapsedMs !== undefined) event.elapsedMs = elapsedMs;
    const safePhase = safeField(phase);
    const safeRequestId = safeField(requestId);
    const safeTraceId = safeField(traceId);
    const safeRoute = safeField(route);
    const safeModel = safeField(model);
    if (safePhase) event.phase = safePhase;
    if (safeRequestId) event.requestId = safeRequestId;
    if (safeTraceId) event.traceId = safeTraceId;
    if (safeRoute) event.route = safeRoute;
    if (safeModel) event.model = safeModel;
    if (Number.isInteger(status) && status >= 100 && status <= 599) {
      event.status = status;
    }
    if (errorCode) event.code = errorCode;
    else if (causeCode) event.code = causeCode;
    const fallback = Object.freeze(sanitizeEventRecord(event) || { type: "request" });
    const append = safeOwnAppend(eventStore);
    if (append) {
      try {
        const rawRecord = append.call(eventStore, Object.freeze({ ...fallback }));
        const record = hasExactStoredShape(rawRecord, fallback)
          ? sanitizeEventRecord(rawRecord, { requireMetadata: true })
          : null;
        if (matchesStoredFallback(record, fallback)) {
          console.error(`[bridge] ${JSON.stringify(record)}`);
          return;
        }
      } catch {
        // Event recording must never expose an operational error or change request handling.
      }
    }
    console.error(`[bridge] ${JSON.stringify(fallback)}`);
    return;
  }
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
