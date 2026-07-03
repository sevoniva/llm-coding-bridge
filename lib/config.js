"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const apiKeyCache = new Map();
const DEFAULT_API_KEY_TTL_MS = 10 * 60 * 1000;

function loadConfig(file) {
  const configPath = path.resolve(file);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const server = { host: "127.0.0.1", port: 18080, ...(config.server || {}) };
  const single = config.upstream || null;
  const list = Array.isArray(config.upstreams) ? config.upstreams : [];
  if (!single && list.length === 0) throw new Error("Missing upstream or upstreams.");
  for (const u of [single, ...list].filter(Boolean)) {
    if (!u.baseUrl) throw new Error("Missing upstream.baseUrl.");
    if (!u.model) throw new Error("Missing upstream.model.");
    if (!u.apiKeyEnv && !u.apiKeyCommand) {
      throw new Error("Missing upstream.apiKeyEnv or upstream.apiKeyCommand.");
    }
  }
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
  const ttl = Number(upstream.apiKeyCacheTtlMs || DEFAULT_API_KEY_TTL_MS);
  const cached = apiKeyCache.get(upstream);
  if (cached && Date.now() - cached.ts < ttl) return cached.value;
  const value = resolveApiKey(upstream);
  apiKeyCache.set(upstream, { value, ts: Date.now() });
  return value;
}

function upstreamUrl(upstream) {
  return `${upstream.baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function localUrl(config, pathname = "") {
  return `http://${config.server.host}:${config.server.port}${pathname}`;
}

module.exports = {
  loadConfig,
  resolveUpstream,
  getApiKey,
  upstreamUrl,
  localUrl,
  DEFAULT_API_KEY_TTL_MS,
};
