"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { types } = require("node:util");
const { normalizeConfigDocument } = require("./config-v2");
const { createCredentialResolver } = require("./credentials");

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
const DEFAULT_SERVER_MAX_BODY_BYTES = 10 * 1024 * 1024;

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
  if (server === undefined) server = {};
  if (server === null || typeof server !== "object" || Array.isArray(server) || types.isProxy(server)) {
    throw new Error("server must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(server);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("server must be a plain object.");
  const descriptors = Object.getOwnPropertyDescriptors(server);
  function value(name, fallback) {
    const descriptor = descriptors[name];
    if (!descriptor) return fallback;
    if (descriptor.get || descriptor.set) throw new Error(`server.${name} must be a scalar value.`);
    return descriptor.value;
  }
  function numeric(name, fallback, allowZero = true) {
    const raw = value(name, fallback);
    if ((typeof raw !== "number" && typeof raw !== "string") || (typeof raw === "string" && !raw.trim())) {
      throw new Error(`server.${name} must be an integer.`);
    }
    return allowZero
      ? nonNegativeInteger(raw, fallback, `server.${name}`)
      : positiveInteger(raw, fallback, `server.${name}`);
  }

  const rawHost = value("host", "127.0.0.1");
  if (typeof rawHost !== "string" || !rawHost.trim()) throw new Error("server.host must be a non-empty string.");
  const port = numeric("port", 37629);
  if (port > 65535) throw new Error("server.port must be between 0 and 65535.");
  const localToken = value("localToken", undefined);
  if (localToken !== undefined && typeof localToken !== "string") {
    throw new Error("server.localToken must be a string when set.");
  }

  const out = {
    host: normalizeListenHost(rawHost),
    port,
    heartbeatIntervalMs: numeric(
      "heartbeatIntervalMs",
      DEFAULT_HEARTBEAT_INTERVAL_MS
    ),
    timeoutMs: numeric("timeoutMs", DEFAULT_SERVER_TIMEOUT_MS),
    requestTimeoutMs: numeric("requestTimeoutMs", DEFAULT_SERVER_REQUEST_TIMEOUT_MS),
    headersTimeoutMs: numeric("headersTimeoutMs", DEFAULT_SERVER_HEADERS_TIMEOUT_MS),
    keepAliveTimeoutMs: numeric("keepAliveTimeoutMs", DEFAULT_SERVER_KEEPALIVE_TIMEOUT_MS),
    maxBodyBytes: numeric("maxBodyBytes", DEFAULT_SERVER_MAX_BODY_BYTES, false),
  };
  if (localToken !== undefined) out.localToken = localToken;
  return Object.freeze(out);
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
  const server = normalizeServer(config.server || {});
  if (!isLoopbackHost(server.host) && !(typeof server.localToken === "string" && server.localToken.trim())) {
    throw new Error("server.localToken is required when server.host is not a loopback address.");
  }
  return Object.freeze({
    path: configPath,
    server,
    version: normalized.version,
    routes: normalized.routes,
    upstreams: normalized.upstreams,
    defaultUpstream: normalized.defaultUpstream,
    credentials: normalized.credentials,
    credentialResolver: normalized.version === 2 ? createCredentialResolver(normalized.credentials) : null,
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
  if (upstream.credentialResolver) {
    return upstream.credentialResolver.resolve(upstream.credentialRef, { clientApiKey: upstream.clientApiKey });
  }
  const ttl = Number(upstream.apiKeyCacheTtlMs ?? DEFAULT_API_KEY_TTL_MS);
  const cached = apiKeyCache.get(upstream);
  if (cached && ttl > 0 && Date.now() - cached.ts < ttl) return cached.value;
  const value = resolveApiKey(upstream);
  if (ttl > 0) apiKeyCache.set(upstream, { value, ts: Date.now() });
  return value;
}

function bustApiKey(upstream) {
  if (upstream.credentialResolver) {
    upstream.credentialResolver.invalidate(upstream.credentialRef);
    return;
  }
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
