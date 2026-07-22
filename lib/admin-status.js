"use strict";

const path = require("node:path");
const packageJson = require("../package.json");
const { zcodeVerificationStatus } = require("./zcode-client");

const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const HEALTH = new Set(["closed", "open", "half_open"]);
const MODALITIES = new Set(["text", "image", "audio"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeCapabilities(value) {
  if (!value || typeof value !== "object") return {};
  const capabilities = {};
  if (Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0) {
    capabilities.contextWindow = value.contextWindow;
  }
  if (Array.isArray(value.inputModalities)) {
    const modalities = value.inputModalities.filter((item, index, items) => (
      typeof item === "string" && MODALITIES.has(item) && items.indexOf(item) === index
    ));
    if (modalities.length) capabilities.inputModalities = modalities;
  }
  if (typeof value.reasoning === "boolean") capabilities.reasoning = value.reasoning;
  return capabilities;
}

function routeCredentialAvailable(runtime, route, env) {
  if (route.credentialRef && runtime.credentialResolver) {
    try {
      return Boolean(runtime.credentialResolver.availability(route.credentialRef));
    } catch {
      return false;
    }
  }
  if (route.apiKeySource === "client") return true;
  if (typeof route.apiKeyEnv === "string" && route.apiKeyEnv) {
    return typeof env[route.apiKeyEnv] === "string" && Boolean(env[route.apiKeyEnv]);
  }
  return typeof route.apiKeyCommand === "string"
    ? Boolean(route.apiKeyCommand.trim())
    : Boolean(route.apiKeyCommand && typeof route.apiKeyCommand === "object");
}

function buildAdminStatus(runtime, options = {}) {
  if (!runtime || typeof runtime !== "object") throw new TypeError("runtime must be an object.");
  const now = options.now || Date.now;
  if (typeof now !== "function") throw new TypeError("options.now must be a function.");
  const currentTime = safeInteger(now()) ?? 0;
  const startedAt = safeInteger(options.startedAt ?? runtime.startedAt) ?? currentTime;
  const env = options.env && typeof options.env === "object" ? options.env : process.env;
  let healthEntries = [];
  try { healthEntries = runtime.healthRegistry?.snapshot(currentTime) || []; } catch {}
  const healthByAlias = new Map(healthEntries.map((entry) => [entry.alias, entry]));
  const routes = [];

  for (const route of runtime.config?.routes || runtime.config?.upstreams || []) {
    if (!route || typeof route.alias !== "string" || !SAFE_ALIAS.test(route.alias)) continue;
    const health = healthByAlias.get(route.alias) || {};
    routes.push({
      alias: route.alias,
      capabilities: safeCapabilities(route.capabilities),
      credentialAvailable: routeCredentialAvailable(runtime, route, env),
      health: HEALTH.has(health.health) ? health.health : "closed",
      consecutiveFailures: safeInteger(health.consecutiveFailures) ?? 0,
      cooldownUntil: safeInteger(health.cooldownUntil),
      halfOpenProbeActive: health.halfOpenProbeActive === true,
      lastSuccessAt: safeInteger(health.lastSuccessAt),
    });
  }

  const configPath = typeof runtime.config?.path === "string" && runtime.config.path
    ? path.resolve(runtime.config.path)
    : null;
  return deepFreeze({
    version: typeof options.version === "string" ? options.version : packageJson.version,
    uptimeMs: Math.max(0, currentTime - startedAt),
    configPath,
    routes,
    zcode: zcodeVerificationStatus(options.zcode || runtime.zcode),
  });
}

module.exports = { buildAdminStatus };
