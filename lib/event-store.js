"use strict";

const { types } = require("node:util");

const DEFAULT_CAPACITY = 500;
const MAX_CAPACITY = 10000;
const MAX_FIELD_LENGTH = 160;
const SAFE_FIELD = /^[A-Za-z0-9/][A-Za-z0-9._:/-]*$/;
const STRING_FIELDS = ["type", "phase", "requestId", "traceId", "route", "model", "category", "code", "outcome"];
const INTEGER_FIELDS = ["attempt", "status", "elapsedMs", "delayMs", "heartbeatCount"];

function safeField(value) {
  if (typeof value !== "string") return "";
  if (value.length > MAX_FIELD_LENGTH) return "";
  const trimmed = value.trim();
  if (!trimmed || !SAFE_FIELD.test(trimmed)) return "";
  return trimmed;
}

function safeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  if (field === "status" && (value < 100 || value > 599)) return undefined;
  return value;
}

function ownDataValue(value, key) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return null;
  }
}

function sanitizeEventRecord(event, { requireMetadata = false } = {}) {
  if (!event || typeof event !== "object" || types.isProxy(event)) return null;
  const record = {};
  if (requireMetadata) {
    for (const field of ["sequence", "timestamp"]) {
      const value = safeInteger(ownDataValue(event, field));
      if (value === undefined) return null;
      record[field] = value;
    }
  }
  for (const field of STRING_FIELDS) {
    const value = safeField(ownDataValue(event, field));
    if (value) record[field] = value;
  }
  for (const field of INTEGER_FIELDS) {
    const value = safeInteger(ownDataValue(event, field), field);
    if (value !== undefined) record[field] = value;
  }
  return record;
}

function validCapacity(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    throw new RangeError(`capacity must be an integer from 1 to ${MAX_CAPACITY}`);
  }
  return capacity;
}

function validTimestamp(now) {
  try {
    const value = now();
    if (Number.isSafeInteger(value) && value >= 0) return value;
  } catch {
    // A diagnostic clock must not affect request handling.
  }
  const fallback = Date.now();
  return Number.isSafeInteger(fallback) && fallback >= 0 ? fallback : 0;
}

function createEventStore({ capacity = DEFAULT_CAPACITY, now = Date.now } = {}) {
  const maxEvents = validCapacity(capacity);
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const events = [];
  let sequence = 0;

  function append(event) {
    const record = sanitizeEventRecord(event) || {};
    // Sequence, not wall-clock time, is the authoritative event ordering cursor.
    const stored = Object.freeze({
      sequence: ++sequence,
      timestamp: validTimestamp(now),
      ...record,
    });
    events.push(stored);
    if (events.length > maxEvents) events.shift();
    return stored;
  }

  function snapshot(options) {
    if (options === undefined) return events.map((event) => ({ ...event }));
    if (!options || typeof options !== "object" || types.isProxy(options)) return [];
    const afterValue = ownDataValue(options, "afterSequence");
    const limitValue = ownDataValue(options, "limit");
    const afterSequence = afterValue === undefined ? 0 : afterValue;
    const limit = limitValue === undefined ? maxEvents : limitValue;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
      !Number.isSafeInteger(limit) || limit < 0) return [];
    const boundedLimit = Math.min(limit, maxEvents);
    return events.filter((event) => event.sequence > afterSequence).slice(0, boundedLimit).map((event) => ({ ...event }));
  }

  return Object.freeze({ append, snapshot });
}

module.exports = { createEventStore, sanitizeEventRecord };
