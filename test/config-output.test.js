"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../lib/config");
const {
  applyMigrationPlan,
  effectiveConfigDocument,
  migrationPlan,
} = require("../lib/config-output");
const {
  atomicReplacePrivate,
  readFileSnapshot,
  verifyPrivateRegularFile,
} = require("../lib/file-safety");

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lcb-config-output-${name}-`));
}

function legacyDocument() {
  return {
    server: {
      host: "127.0.0.1",
      port: 37629,
      localToken: "synthetic-local-secret",
    },
    upstreams: [
      {
        name: "Shared Provider",
        baseUrl: "https://api.example.com/v1",
        model: "coding-fast",
        apiKeyEnv: "MODEL_FAST_API_KEY",
        timeoutMs: 700001,
        heartbeatIntervalMs: 16000,
      },
      {
        name: "Shared Provider",
        baseUrl: "https://api.example.com/v1",
        model: "coding-strong",
        apiKeyCommand: {
          command: "/usr/bin/security",
          args: ["find-generic-password", "-w", "synthetic-command-selector"],
        },
        reliabilityPolicy: "long-thinking",
      },
    ],
  };
}

function writeLegacy(directory, name = "config.json") {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `${JSON.stringify(legacyDocument(), null, 2)}\n`, { mode: 0o644 });
  return file;
}

function runCli(args, env = {}) {
  const cli = path.join(__dirname, "..", "bin", "llm-coding-bridge.js");
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

function assertNoSecrets(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  assert.doesNotMatch(text, /synthetic-local-secret/);
  assert.doesNotMatch(text, /synthetic-env-secret/);
  assert.doesNotMatch(text, /synthetic-command-selector/);
  assert.doesNotMatch(text, /synthetic-command-stdout/);
  assert.doesNotMatch(text, /synthetic-client-key/);
}

async function testEffectiveOutputAndMigration() {
  const directory = tmpDir("migration");
  const file = writeLegacy(directory);
  process.env.MODEL_FAST_API_KEY = "synthetic-env-secret";
  try {
    const config = loadConfig(file);
    const effective = effectiveConfigDocument(config);
    assert.equal(effective.version, 1);
    assert.equal(effective.configSource, file);
    assert.deepEqual(effective.server, {
      host: "127.0.0.1",
      port: 37629,
      localTokenConfigured: true,
    });
    assert.deepEqual(effective.routes.map((route) => ({
      alias: route.alias,
      providerId: route.provider.id,
      providerName: route.provider.name,
      baseUrl: route.provider.baseUrl,
      upstreamModel: route.upstreamModel,
      credentialRef: route.credential.ref,
      credentialSource: route.credential.source,
      credentialReference: route.credential.reference,
      reliabilityPolicy: route.reliabilityPolicy,
    })), [
      {
        alias: "coding-fast",
        providerId: "legacy-1",
        providerName: "Shared Provider",
        baseUrl: "https://api.example.com/v1",
        upstreamModel: "coding-fast",
        credentialRef: "legacy-1",
        credentialSource: "env",
        credentialReference: "MODEL_FAST_API_KEY",
        reliabilityPolicy: "stable",
      },
      {
        alias: "coding-strong",
        providerId: "legacy-2",
        providerName: "Shared Provider",
        baseUrl: "https://api.example.com/v1",
        upstreamModel: "coding-strong",
        credentialRef: "legacy-2",
        credentialSource: "command",
        credentialReference: "/usr/bin/security",
        reliabilityPolicy: "long-thinking",
      },
    ]);
    assert.deepEqual(effective.routes[0].reliability.nonStreamingTotalTimeoutMs, {
      value: 600000,
      source: "built_in",
    });
    assertNoSecrets(effective);

    const snapshot = readFileSnapshot(file);
    const plan = migrationPlan(config, snapshot);
    assert.equal(plan.document.version, 2);
    assert.equal(plan.document.server.localToken, "synthetic-local-secret");
    assert.equal(plan.document.providers.length, 1);
    assert.equal(plan.document.providers[0].id, "shared-provider");
    assert.deepEqual(plan.document.providers[0].models.map((model) => model.alias), ["coding-fast", "coding-strong"]);
    assert.deepEqual(Object.keys(plan.document.credentials), [
      "shared-provider-coding-fast",
      "shared-provider-coding-strong",
    ]);
    assertNoSecrets(plan.preview);

    const before = fs.readFileSync(file);
    const beforeStat = fs.statSync(file);
    const dryRun = await runCli(["config", "migrate", "--dry-run", "--config", file], {
      MODEL_FAST_API_KEY: "synthetic-env-secret",
    });
    assert.equal(dryRun.code, 0, dryRun.stderr || dryRun.stdout);
    assert.match(dryRun.stdout, /"version": 2/);
    assertNoSecrets(dryRun.stdout + dryRun.stderr);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(fs.statSync(file).mtimeMs, beforeStat.mtimeMs);

    const show = await runCli(["config", "show", "--effective", "--config", file], {
      MODEL_FAST_API_KEY: "synthetic-env-secret",
    });
    assert.equal(show.code, 0, show.stderr || show.stdout);
    assertNoSecrets(show.stdout + show.stderr);

    const applied = applyMigrationPlan(plan, { now: new Date("2026-07-22T01:02:03Z") });
    assert.equal(applied.file, file);
    assert.equal(applied.backup, `${file}.bak-20260722-010203`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(applied.backup).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(applied.backup, "utf8"), before.toString("utf8"));
    const migrated = loadConfig(file);
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.routes.map((route) => ({
      alias: route.alias,
      model: route.upstreamModel,
      baseUrl: route.baseUrl,
      source: route.credential.source,
    })), [
      { alias: "coding-fast", model: "coding-fast", baseUrl: "https://api.example.com/v1", source: "env" },
      { alias: "coding-strong", model: "coding-strong", baseUrl: "https://api.example.com/v1", source: "command" },
    ]);
    assert.equal(migrated.routes[0].timeoutMs, 700001);
    assert.equal(migrated.routes[0].heartbeatIntervalMs, 16000);
    assert.equal(migrated.server.localToken, "synthetic-local-secret");
  } finally {
    delete process.env.MODEL_FAST_API_KEY;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testConcurrentChangeStopsApply() {
  const directory = tmpDir("concurrent");
  try {
    const file = path.join(directory, "state.json");
    fs.writeFileSync(file, '{"value":1}\n');
    const snapshot = readFileSnapshot(file);
    fs.writeFileSync(file, '{"value":2}\n');
    assert.throws(
      () => atomicReplacePrivate(snapshot, '{"value":3}\n'),
      /changed since it was read/i
    );
    assert.equal(fs.readFileSync(file, "utf8"), '{"value":2}\n');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testConcurrentChangeStopsMigrationWithoutRollback() {
  const directory = tmpDir("concurrent-migration");
  try {
    const file = writeLegacy(directory);
    const config = loadConfig(file);
    const plan = migrationPlan(config, readFileSnapshot(file));
    const concurrent = `${JSON.stringify({ ...legacyDocument(), operatorNote: "keep-concurrent-change" }, null, 2)}\n`;
    fs.writeFileSync(file, concurrent);
    assert.throws(() => applyMigrationPlan(plan), /changed since it was read/i);
    assert.equal(fs.readFileSync(file, "utf8"), concurrent);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testAtomicDurabilityAndSymlinkPreservation() {
  const directory = tmpDir("atomic");
  try {
    const target = path.join(directory, "target.json");
    const link = path.join(directory, "config.json");
    fs.writeFileSync(target, '{"value":1}\n', { mode: 0o644 });
    fs.symlinkSync("target.json", link);
    const snapshot = readFileSnapshot(link);

    const originalFsync = fs.fsyncSync;
    let fsyncCount = 0;
    fs.fsyncSync = function countedFsync(descriptor) {
      fsyncCount += 1;
      return originalFsync(descriptor);
    };
    try {
      atomicReplacePrivate(snapshot, '{"value":2}\n');
    } finally {
      fs.fsyncSync = originalFsync;
    }

    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, "utf8"), '{"value":2}\n');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.ok(fsyncCount >= 2, "temporary file and containing directory must both be fsynced");
    assert.equal(verifyPrivateRegularFile(link).target, fs.realpathSync(target));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  await testEffectiveOutputAndMigration();
  testConcurrentChangeStopsApply();
  testConcurrentChangeStopsMigrationWithoutRollback();
  testAtomicDurabilityAndSymlinkPreservation();
  console.log("config output tests passed");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
