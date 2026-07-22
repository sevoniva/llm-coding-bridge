"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { buildAdminStatus } = require("../lib/admin-status");
const { zcodeVerificationStatus } = require("../lib/zcode-client");

const credentialReferences = [];
const runtime = {
  config: {
    path: "/tmp/bridge/config.json",
    routes: [{
      alias: "coding-fast",
      credentialRef: "credential-fast",
      capabilities: {
        contextWindow: 128000,
        inputModalities: ["text", "image"],
        reasoning: true,
        privateDescription: "prompt-secret",
      },
      baseUrl: "https://private.example/v1",
      credential: { key: "key-secret" },
    }],
  },
  credentialResolver: {
    availability(reference) {
      credentialReferences.push(reference);
      return true;
    },
  },
  healthRegistry: {
    snapshot() {
      return [{
        alias: "coding-fast",
        health: "closed",
        consecutiveFailures: 0,
        cooldownUntil: null,
        halfOpenProbeActive: false,
        lastSuccessAt: 1000,
        rawError: "response-secret",
      }];
    },
  },
  eventStore: {
    snapshot() {
      return [{ type: "attempt", prompt: "event-secret" }];
    },
  },
  localToken: "local-secret",
};

const zcode = zcodeVerificationStatus({
  version: "3.8.1",
  supported: true,
  previewOnly: false,
  managedProviderPresent: true,
  aliasCount: 2,
  privateMode: true,
  lastVerifiedAt: 1500,
  providers: [{ apiKey: "zcode-secret" }],
});

assert.deepEqual(zcode, {
  version: "3.8.1",
  supported: true,
  previewOnly: false,
  managedProviderPresent: true,
  aliasCount: 2,
  privateMode: true,
  lastVerifiedAt: 1500,
});
assert.equal(Object.isFrozen(zcode), true);

const snapshot = buildAdminStatus(runtime, {
  version: "0.7.0",
  startedAt: 500,
  now: () => 2000,
  zcode,
});

assert.deepEqual(snapshot, {
  version: "0.7.0",
  uptimeMs: 1500,
  configPath: path.resolve("/tmp/bridge/config.json"),
  routes: [{
    alias: "coding-fast",
    capabilities: {
      contextWindow: 128000,
      inputModalities: ["text", "image"],
      reasoning: true,
    },
    credentialAvailable: true,
    health: "closed",
    consecutiveFailures: 0,
    cooldownUntil: null,
    halfOpenProbeActive: false,
    lastSuccessAt: 1000,
  }],
  zcode,
});
assert.deepEqual(credentialReferences, ["credential-fast"]);
assert.equal(Object.isFrozen(snapshot), true);
assert.equal(Object.isFrozen(snapshot.routes), true);
assert.equal(Object.isFrozen(snapshot.routes[0]), true);
assert.equal(Object.isFrozen(snapshot.routes[0].capabilities), true);
assert.doesNotMatch(JSON.stringify(snapshot), /prompt-secret|response-secret|event-secret|key-secret|local-secret|private\.example|zcode-secret/);

const unavailable = buildAdminStatus({
  config: { routes: [{ alias: "legacy", capabilities: {} }] },
  credentialResolver: null,
  healthRegistry: { snapshot: () => [] },
}, { version: "0.7.0", startedAt: 2000, now: () => 1000 });
assert.equal(unavailable.uptimeMs, 0);
assert.equal(unavailable.routes[0].credentialAvailable, false);
assert.equal(unavailable.routes[0].health, "closed");

console.log("admin tests passed");
