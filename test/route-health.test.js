"use strict";

const assert = require("node:assert/strict");
const { BridgeError } = require("../lib/bridge-error");
const { createRouteHealthRegistry } = require("../lib/route-health");

let now = 1000;
const registry = createRouteHealthRegistry({ clock: () => now });
const retryable = new BridgeError({ category: "network", retryable: true });

assert.deepEqual(registry.acquire("coding-fast", now), {
  allowed: true,
  health: "closed",
  probe: false,
  waitMs: 0,
  reason: "route_available",
});

for (let count = 1; count <= 4; count += 1) {
  const result = registry.recordTerminalFailure("coding-fast", retryable, now);
  assert.equal(result.health, "closed");
  assert.equal(result.consecutiveFailures, count);
}
const opened = registry.recordTerminalFailure("coding-fast", retryable, now);
assert.equal(opened.health, "open");
assert.equal(opened.cooldownUntil, 31000);

assert.equal(registry.acquire("coding-strong", now).allowed, true);
assert.equal(registry.acquire("org/legacy:model", now).allowed, true);
assert.deepEqual(registry.acquire("coding-fast", 30000), {
  allowed: false,
  health: "open",
  probe: false,
  waitMs: 1000,
  reason: "route_cooldown",
});
assert.equal(registry.acquire("coding-fast", 30000).waitMs <= 30000, true);
assert.equal(registry.acquire("coding-fast", 30000).waitMs <= 500, false);

assert.deepEqual(registry.acquire("coding-fast", 31000), {
  allowed: true,
  health: "half_open",
  probe: true,
  waitMs: 0,
  reason: "half_open_probe",
});
assert.deepEqual(registry.acquire("coding-fast", 31000), {
  allowed: false,
  health: "half_open",
  probe: false,
  waitMs: 0,
  reason: "half_open_probe_active",
});

now = 31001;
const closed = registry.recordSuccess("coding-fast");
assert.equal(closed.health, "closed");
assert.equal(closed.consecutiveFailures, 0);
assert.equal(closed.lastSuccessAt, now);
assert.equal(registry.acquire("coding-fast", now).allowed, true);

for (let count = 0; count < 5; count += 1) registry.recordTerminalFailure("coding-fast", retryable, now);
now += 30000;
assert.equal(registry.acquire("coding-fast", now).probe, true);
const reopened = registry.recordTerminalFailure("coding-fast", retryable, now);
assert.equal(reopened.health, "open");
assert.equal(reopened.cooldownUntil, now + 30000);

now = reopened.cooldownUntil;
assert.equal(registry.acquire("coding-fast", now).probe, true);
assert.equal(registry.releaseProbe("coding-fast").halfOpenProbeActive, false);
assert.equal(registry.acquire("coding-fast", now).probe, true);

const capped = createRouteHealthRegistry({ failureThreshold: 1 });
const rateLimited = new BridgeError({
  category: "rate_limit",
  retryable: true,
  retryAfterMs: 999000,
});
assert.equal(capped.recordTerminalFailure("limited", rateLimited, 500).cooldownUntil, 120500);

const ignored = createRouteHealthRegistry({ failureThreshold: 1 });
ignored.recordTerminalFailure("bad-request", new BridgeError({
  category: "invalid_request",
  retryable: false,
  status: 400,
}), 0);
assert.equal(ignored.snapshot(0)[0].health, "closed");
assert.equal(ignored.snapshot(0)[0].consecutiveFailures, 0);

const snapshot = registry.snapshot(now);
assert.equal(Object.isFrozen(snapshot), true);
assert.equal(Object.isFrozen(snapshot[0]), true);
assert.deepEqual(snapshot.map(({ alias, health }) => ({ alias, health })), [
  { alias: "coding-fast", health: "half_open" },
  { alias: "coding-strong", health: "closed" },
  { alias: "org/legacy:model", health: "closed" },
]);

assert.throws(() => registry.acquire("", now), /alias/i);
assert.throws(() => registry.acquire("coding-fast", -1), /now/i);

console.log("route health tests passed");
