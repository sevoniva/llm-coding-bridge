"use strict";

const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

function requireInteger(value, minimum, name) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${name} must be a safe integer.`);
  return value;
}

function requireAlias(alias) {
  if (typeof alias !== "string" || !SAFE_ALIAS.test(alias)) throw new TypeError("alias must be a safe identifier.");
  return alias;
}

function createRouteHealthRegistry(options = {}) {
  const failureThreshold = requireInteger(options.failureThreshold ?? 5, 1, "failureThreshold");
  const cooldownMs = requireInteger(options.cooldownMs ?? 30000, 0, "cooldownMs");
  const maxCooldownMs = requireInteger(options.maxCooldownMs ?? 120000, cooldownMs, "maxCooldownMs");
  const clock = options.clock ?? Date.now;
  if (typeof clock !== "function") throw new TypeError("clock must be a function.");
  const entries = new Map();

  function get(alias) {
    requireAlias(alias);
    if (!entries.has(alias)) {
      entries.set(alias, {
        alias,
        health: "closed",
        consecutiveFailures: 0,
        cooldownUntil: null,
        halfOpenProbeActive: false,
        lastSuccessAt: null,
      });
    }
    return entries.get(alias);
  }

  function publicEntry(entry) {
    return Object.freeze({ ...entry });
  }

  function acquire(alias, now = clock()) {
    requireInteger(now, 0, "now");
    const entry = get(alias);
    if (entry.health === "closed") {
      return Object.freeze({ allowed: true, health: "closed", probe: false, waitMs: 0, reason: "route_available" });
    }
    if (entry.health === "open" && now < entry.cooldownUntil) {
      return Object.freeze({
        allowed: false,
        health: "open",
        probe: false,
        waitMs: entry.cooldownUntil - now,
        reason: "route_cooldown",
      });
    }
    if (entry.health === "open") entry.health = "half_open";
    if (entry.halfOpenProbeActive) {
      return Object.freeze({
        allowed: false,
        health: "half_open",
        probe: false,
        waitMs: 0,
        reason: "half_open_probe_active",
      });
    }
    entry.halfOpenProbeActive = true;
    return Object.freeze({ allowed: true, health: "half_open", probe: true, waitMs: 0, reason: "half_open_probe" });
  }

  function recordSuccess(alias) {
    const entry = get(alias);
    const now = clock();
    requireInteger(now, 0, "clock result");
    entry.health = "closed";
    entry.consecutiveFailures = 0;
    entry.cooldownUntil = null;
    entry.halfOpenProbeActive = false;
    entry.lastSuccessAt = now;
    return publicEntry(entry);
  }

  function recordTerminalFailure(alias, error, now = clock()) {
    requireInteger(now, 0, "now");
    const entry = get(alias);
    if (!error || typeof error !== "object" || error.retryable !== true) return publicEntry(entry);
    entry.consecutiveFailures = Math.min(Number.MAX_SAFE_INTEGER, entry.consecutiveFailures + 1);
    if (entry.health !== "half_open" && entry.consecutiveFailures < failureThreshold) return publicEntry(entry);

    const retryAfterMs = Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : 0;
    const appliedCooldownMs = Math.min(maxCooldownMs, Math.max(cooldownMs, retryAfterMs));
    entry.health = "open";
    entry.cooldownUntil = now + appliedCooldownMs;
    entry.halfOpenProbeActive = false;
    return publicEntry(entry);
  }

  function releaseProbe(alias) {
    const entry = get(alias);
    if (entry.health === "half_open") entry.halfOpenProbeActive = false;
    return publicEntry(entry);
  }

  function snapshot(now = clock()) {
    requireInteger(now, 0, "now");
    return Object.freeze([...entries.values()]
      .sort((left, right) => left.alias.localeCompare(right.alias))
      .map(publicEntry));
  }

  return Object.freeze({ acquire, recordSuccess, recordTerminalFailure, releaseProbe, snapshot });
}

module.exports = { createRouteHealthRegistry };
