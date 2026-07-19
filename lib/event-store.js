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
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD_LENGTH || !SAFE_FIELD.test(trimmed)) return "";
  return trimmed;
}

function safeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) return undefined;
  if (field === "status" && (value < 100 || value > 599)) return undefined;
  return value;
}

function ownDataProperties(value) {
  if (!value || typeof value !== "object" || types.isProxy(value)) return null;
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function safeEvent(event) {
  const descriptors = ownDataProperties(event);
  if (!descriptors) return {};
  const record = {};
  for (const field of STRING_FIELDS) {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor)) continue;
    const value = safeField(descriptor.value);
    if (value) record[field] = value;
  }
  for (const field of INTEGER_FIELDS) {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor)) continue;
    const value = safeInteger(descriptor.value, field);
    if (value !== undefined) record[field] = value;
  }
  return record;
}

function validCapacity(capacity) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) {
    throw new RangeError(`capacity must be an integer from 1 to ${MAX_CAPACITY}`);
  }
  return capacity;
}

function validTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : Date.now();
}

function createEventStore({ capacity = DEFAULT_CAPACITY, now = Date.now } = {}) {
  const maxEvents = validCapacity(capacity);
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const events = [];
  let sequence = 0;

  function append(event) {
    const record = safeEvent(event);
    const stored = Object.freeze({
      sequence: ++sequence,
      timestamp: validTimestamp(now()),
      ...record,
    });
    events.push(stored);
    if (events.length > maxEvents) events.shift();
    return stored;
  }

  function snapshot(options) {
    if (options === undefined) return events.map((event) => ({ ...event }));
    const descriptors = ownDataProperties(options);
    if (!descriptors) return [];
    const afterValue = descriptors.afterSequence;
    const limitValue = descriptors.limit;
    const afterSequence = afterValue && "value" in afterValue ? afterValue.value : 0;
    const limit = limitValue && "value" in limitValue ? limitValue.value : maxEvents;
    if (!Number.isInteger(afterSequence) || afterSequence < 0 ||
      !Number.isInteger(limit) || limit < 0) return [];
    const boundedLimit = Math.min(limit, maxEvents);
    return events.filter((event) => event.sequence > afterSequence).slice(0, boundedLimit).map((event) => ({ ...event }));
  }

  return Object.freeze({ append, snapshot });
}

module.exports = { createEventStore };
