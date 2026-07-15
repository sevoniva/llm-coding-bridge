"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const apiKeyCache = new WeakMap();
const DEFAULT_API_KEY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SSE_EVENT_BYTES = 1024 * 1024;

function isLoopbackHost(host) {
  let normalized = String(host || "").trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
  if (normalized === "localhost" || normalized === "localhost.") return true;
  if (net.isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  if (net.isIP(normalized) !== 6) return false;
  if (normalized === "::1") return true;
  const mapped = normalized.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  return Boolean(mapped && mapped[1] === "127");
}

function normalizeListenHost(host) {
  const normalized = String(host || "").trim();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    const unwrapped = normalized.slice(1, -1);
    if (net.isIP(unwrapped) === 6) return unwrapped;
  }
  return normalized;
}

function positiveInteger(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return number;
}

function normalizeUpstream(upstream) {
  return {
    ...upstream,
    timeoutMs: positiveInteger(upstream.timeoutMs, DEFAULT_UPSTREAM_TIMEOUT_MS, "upstream.timeoutMs"),
    maxResponseBytes: positiveInteger(upstream.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "upstream.maxResponseBytes"),
    maxSseEventBytes: positiveInteger(upstream.maxSseEventBytes, DEFAULT_MAX_SSE_EVENT_BYTES, "upstream.maxSseEventBytes"),
  };
}

function loadConfig(file) {
  const configPath = path.resolve(file);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Run "llm-coding-bridge init" to create one.`);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Config file is not valid JSON: ${configPath} (${error.message})`);
  }
  const server = { host: "127.0.0.1", port: 37629, ...(config.server || {}) };
  server.host = normalizeListenHost(server.host);
  if (!isLoopbackHost(server.host) && !(typeof server.localToken === "string" && server.localToken.trim())) {
    throw new Error("server.localToken is required when server.host is not a loopback address.");
  }
  const rawSingle = config.upstream || null;
  const rawList = Array.isArray(config.upstreams) ? config.upstreams : [];
  if (!rawSingle && rawList.length === 0) throw new Error("Missing upstream or upstreams.");
  for (const u of [rawSingle, ...rawList].filter(Boolean)) {
    if (!u.baseUrl) throw new Error("Missing upstream.baseUrl.");
    if (!u.model) throw new Error("Missing upstream.model.");
    if (u.apiKeySource && u.apiKeySource !== "client") {
      throw new Error("upstream.apiKeySource must be \"client\" when set.");
    }
    if (u.apiKeySource !== "client" && !u.apiKeyEnv && !u.apiKeyCommand) {
      throw new Error("Missing upstream.apiKeyEnv, upstream.apiKeyCommand, or upstream.apiKeySource.");
    }
  }
  const single = rawSingle ? normalizeUpstream(rawSingle) : null;
  const list = rawList.map(normalizeUpstream);
  const upstreams = list.length ? list : [single];
  return { path: configPath, server, upstreams, defaultUpstream: single || upstreams[0] };
}

function resolveUpstream(config, model) {
  if (model) {
    const hit = config.upstreams.find((u) => u.model === model);
    if (hit) return hit;
  }
  // Single upstream: fall back to it for backward compat (client model is rewritten).
  if (config.upstreams.length <= 1) return config.defaultUpstream;
  // Multiple upstreams: an unknown model is a misconfiguration; return null so the
  // server can 404 rather than silently routing to the wrong upstream.
  return null;
}

function resolveApiKey(upstream) {
  if (upstream.apiKeySource === "client") {
    if (!upstream.clientApiKey) throw new Error("Missing client API key.");
    return upstream.clientApiKey;
  }
  if (upstream.apiKeyEnv && process.env[upstream.apiKeyEnv]) {
    return process.env[upstream.apiKeyEnv];
  }
  if (!upstream.apiKeyCommand) {
    throw new Error(`Missing API key env: ${upstream.apiKeyEnv}`);
  }
  const command = upstream.apiKeyCommand;
  const result =
    typeof command === "string"
      ? spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" })
      : spawnSync(command.command, command.args || [], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`apiKeyCommand exited with ${result.status}.`);
  const token = result.stdout.trim();
  if (!token) throw new Error("apiKeyCommand returned an empty token.");
  return token;
}

function getApiKey(upstream) {
  const ttl = Number(upstream.apiKeyCacheTtlMs ?? DEFAULT_API_KEY_TTL_MS);
  const cached = apiKeyCache.get(upstream);
  if (cached && ttl > 0 && Date.now() - cached.ts < ttl) return cached.value;
  const value = resolveApiKey(upstream);
  if (ttl > 0) apiKeyCache.set(upstream, { value, ts: Date.now() });
  return value;
}

function bustApiKey(upstream) {
  apiKeyCache.delete(upstream);
}

function upstreamUrl(upstream) {
  return `${upstream.baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function localUrl(config, pathname = "") {
  const host = net.isIP(config.server.host) === 6 ? `[${config.server.host}]` : config.server.host;
  return `http://${host}:${config.server.port}${pathname}`;
}

module.exports = {
  loadConfig,
  resolveUpstream,
  getApiKey,
  bustApiKey,
  upstreamUrl,
  localUrl,
  isLoopbackHost,
  DEFAULT_API_KEY_TTL_MS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_SSE_EVENT_BYTES,
};
