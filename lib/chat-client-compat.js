"use strict";

const DEEPSEEK_HARNESS_USER_AGENT = /^deepseek-harness\/[^\s]+(?:\s|$)/i;
const HARNESS_FORWARD_HEADERS = Object.freeze([
  "user-agent",
  "x-deepseek-harness-user-id",
  "x-deepseek-harness-session-id",
  "x-deepseek-harness-compact",
]);

const DEFAULT_CHAT_CLIENT = Object.freeze({
  deferStreamHeaders: false,
  preserveEmptyAssistantContent: false,
  upstreamHeaders: Object.freeze({}),
});

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function selectedHeaders(headers, names) {
  const selected = {};
  for (const name of names) {
    const value = firstHeader(headers?.[name]);
    if (typeof value === "string" && value) selected[name] = value;
  }
  return Object.freeze(selected);
}

function chatClientCompatibility(req) {
  const userAgent = firstHeader(req?.headers?.["user-agent"]);
  if (typeof userAgent !== "string" || !DEEPSEEK_HARNESS_USER_AGENT.test(userAgent)) {
    return DEFAULT_CHAT_CLIENT;
  }
  return Object.freeze({
    deferStreamHeaders: true,
    preserveEmptyAssistantContent: true,
    upstreamHeaders: selectedHeaders(req.headers, HARNESS_FORWARD_HEADERS),
  });
}

module.exports = { chatClientCompatibility };
