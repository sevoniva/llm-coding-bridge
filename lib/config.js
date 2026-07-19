"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { normalizeConfigDocument } = require("./config-v2");

const apiKeyCache = new WeakMap();
const DEFAULT_API_KEY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SSE_EVENT_BYTES = 1024 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 1000;
// Server (client<->bridge) timeouts. By default the bridge leaves Node's socket
// inactivity timeout disabled (server.timeout = 0) so long-running streams are
// not cut mid-flight; the upstream timeout (lib/upstream.js) bounds the actual
// upstream wait. These are exposed for operators who want to tighten them.
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 0;        // 0 = disabled (Node default 5min)
const DEFAULT_SERVER_HEADERS_TIMEOUT_MS = 65 * 1000;
const DEFAULT_SERVER_KEEPALIVE_TIMEOUT_MS = 5 * 1000;
const DEFAULT_SERVER_TIMEOUT_MS = 0;                 // 0 = disabled (socket inactivity)

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

// Like positiveInteger but allows 0 (used for timeouts/heartbeats where 0 means
// "disabled"). Negative and non-integer values are still rejected.
function nonNegativeInteger(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return number;
}

function normalizeServer(server) {
  const out = { ...server };
  out.heartbeatIntervalMs = nonNegativeInteger(
    server.heartbeatIntervalMs,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
    "server.heartbeatIntervalMs"
  );
  out.timeoutMs = nonNegativeInteger(server.timeoutMs, DEFAULT_SERVER_TIMEOUT_MS, "server.timeoutMs");
  out.requestTimeoutMs = nonNegativeInteger(server.requestTimeoutMs, DEFAULT_SERVER_REQUEST_TIMEOUT_MS, "server.requestTimeoutMs");
  out.headersTimeoutMs = nonNegativeInteger(server.headersTimeoutMs, DEFAULT_SERVER_HEADERS_TIMEOUT_MS, "server.headersTimeoutMs");
  out.keepAliveTimeoutMs = nonNegativeInteger(server.keepAliveTimeoutMs, DEFAULT_SERVER_KEEPALIVE_TIMEOUT_MS, "server.keepAliveTimeoutMs");
  return out;
}

function loadConfig(file) {
  const configPath = path.resolve(file);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}. Run "llm-coding-bridge init" to create one.`);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    throw new Error(`Config file is not valid JSON: ${configPath}.`);
  }
  const normalized = normalizeConfigDocument(config, configPath);
  const server = normalizeServer({ host: "127.0.0.1", port: 37629, ...(config.server || {}) });
  server.host = normalizeListenHost(server.host);
  if (!isLoopbackHost(server.host) && !(typeof server.localToken === "string" && server.localToken.trim())) {
    throw new Error("server.localToken is required when server.host is not a loopback address.");
  }
  return Object.freeze({
    path: configPath,
    server: Object.freeze(server),
    version: normalized.version,
    routes: normalized.routes,
    upstreams: normalized.upstreams,
    defaultUpstream: normalized.defaultUpstream,
    credentials: normalized.credentials,
    effective: normalized.effective,
  });
}

function resolveUpstream(config, model) {
  const routes = config.routes || config.upstreams || [];
  if (model) {
    const hit = routes.find((route) => (
      config.version === 2 ? route.alias === model : (route.alias || route.model) === model
    ));
    if (hit) return hit;
  }
  if (config.version === 2) return null;
  // Single upstream: fall back to it for backward compat (client model is rewritten).
  if (routes.length <= 1) return config.defaultUpstream;
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
  const url = new URL(upstream.baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  url.hash = "";
  return url.toString();
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
  normalizeServer,
  DEFAULT_API_KEY_TTL_MS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MAX_SSE_EVENT_BYTES,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_SERVER_TIMEOUT_MS,
  DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
  DEFAULT_SERVER_HEADERS_TIMEOUT_MS,
  DEFAULT_SERVER_KEEPALIVE_TIMEOUT_MS,
};
