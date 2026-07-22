"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  applyZcodePlan,
  applyZcodeRollback,
  detectZcodeState,
  planZcodeChange,
  planZcodeRollback,
  zcodeVerificationStatus,
} = require("../lib/zcode-client");

const FIXED_PROVIDER_ID = "llm-coding-bridge-11111111-1111-4111-8111-111111111111";

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lcb-zcode-${name}-`));
}

function configPath(home) {
  return path.join(home, ".zcode", "v2", "config.json");
}

function statePath(home) {
  return path.join(home, ".llm-coding-bridge", "zcode-state.json");
}

function cliConfigPath(home) {
  return path.join(home, ".zcode", "cli", "config.json");
}

function bridgeConfig(aliases = ["coding-fast", "coding-strong"]) {
  return {
    path: "/tmp/bridge.json",
    version: 2,
    server: { host: "127.0.0.1", port: 37629, localToken: "synthetic-zcode-local-token" },
    routes: aliases.map((alias, index) => ({
      alias,
      upstreamModel: `upstream-${index + 1}`,
      capabilities: index === 0
        ? { contextWindow: 131072, inputModalities: ["text", "image"], reasoning: true }
        : { inputModalities: ["text"], reasoning: false },
    })),
  };
}

function existingDocument() {
  return {
    futureRoot: { keep: [1, 2, 3] },
    provider: {
      builtin: {
        name: "Built In",
        kind: "openai-compatible",
        source: "built-in",
        options: { baseURL: "https://builtin.example/v1", apiKey: "builtin-synthetic-key" },
        models: { builtin: { futureModelField: true } },
        futureProviderField: { keep: true },
      },
      unrelated: {
        name: "Unrelated Custom",
        kind: "openai-compatible",
        source: "custom",
        options: { baseURL: "https://unrelated.example/v1", apiKey: "unrelated-synthetic-key" },
        models: { unrelated: { limit: { context: 8192 }, modalities: { input: ["text"], output: ["text"] } } },
      },
    },
  };
}

function writeFixture(home, document = existingDocument(), options = {}) {
  const file = configPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: options.mode || 0o644 });
  const cli = cliConfigPath(home);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '{"mcp":{"keep":true}}\n', { mode: 0o644 });
  return { file, cli, cliBytes: fs.readFileSync(cli) };
}

function detect(home, options = {}) {
  return detectZcodeState({ home, version: options.version || "3.3.6" });
}

function planAdd(home, options = {}) {
  return planZcodeChange({
    action: "add",
    config: options.config || bridgeConfig(),
    home,
    state: options.state || detect(home, options),
    managedProviderId: options.managedProviderId || FIXED_PROVIDER_ID,
  });
}

function assertPrivate(file) {
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
}

function testStatusSanitization() {
  assert.deepEqual(zcodeVerificationStatus(), {
    version: null,
    supported: false,
    previewOnly: false,
    managedProviderPresent: false,
    aliasCount: 0,
    privateMode: false,
    lastVerifiedAt: null,
  });
  assert.deepEqual(zcodeVerificationStatus({
    version: "unknown version with secret",
    supported: "yes",
    previewOnly: true,
    managedProviderPresent: true,
    aliasCount: -1,
    privateMode: true,
    lastVerifiedAt: -1,
  }), {
    version: null,
    supported: false,
    previewOnly: true,
    managedProviderPresent: true,
    aliasCount: 0,
    privateMode: true,
    lastVerifiedAt: null,
  });
}

function testAddPreservesEverythingAndIsIdempotent() {
  const home = tmpHome("add");
  try {
    const fixture = writeFixture(home);
    const before = JSON.parse(fs.readFileSync(fixture.file, "utf8"));
    const beforeUnrelated = JSON.stringify(before.provider.unrelated);
    const beforeBuiltin = JSON.stringify(before.provider.builtin);
    const state = detect(home);
    assert.equal(state.supported, true);
    assert.equal(state.previewOnly, false);
    assert.equal(state.bridgeState, null);

    const plan = planAdd(home, { state });
    assert.equal(plan.previewOnly, false);
    assert.equal(plan.noChange, false);
    assert.deepEqual(plan.changes, [{ op: "add", path: `/provider/${FIXED_PROVIDER_ID}` }]);
    assert.deepEqual(state.document, before, "planning must not mutate the detected document");
    const managed = plan.nextDocument.provider[FIXED_PROVIDER_ID];
    assert.deepEqual({ name: managed.name, kind: managed.kind, source: managed.source }, {
      name: "LLM Coding Bridge",
      kind: "openai-compatible",
      source: "custom",
    });
    assert.deepEqual(managed.options, {
      baseURL: "http://127.0.0.1:37629/v1",
      apiKey: "synthetic-zcode-local-token",
      apiKeyRequired: true,
    });
    assert.deepEqual(Object.keys(managed.models), ["coding-fast", "coding-strong"]);
    assert.deepEqual(managed.models["coding-fast"], {
      name: "coding-fast",
      reasoning: { enabled: true, variants: ["low", "high"], defaultVariant: "high" },
      limit: { context: 131072 },
      modalities: { input: ["text", "image"], output: ["text"] },
    });
    assert.deepEqual(managed.models["coding-strong"], {
      name: "coding-strong",
      limit: { context: 128000 },
      modalities: { input: ["text"], output: ["text"] },
    });

    const applied = applyZcodePlan(plan, { now: new Date("2026-07-22T02:03:04Z") });
    assert.equal(applied.changed, true);
    assert.ok(applied.backup);
    assertPrivate(fixture.file);
    assertPrivate(applied.backup);
    assertPrivate(statePath(home));
    assert.deepEqual(fs.readFileSync(fixture.cli), fixture.cliBytes);
    const after = JSON.parse(fs.readFileSync(fixture.file, "utf8"));
    assert.equal(JSON.stringify(after.provider.unrelated), beforeUnrelated);
    assert.equal(JSON.stringify(after.provider.builtin), beforeBuiltin);
    assert.deepEqual(after.futureRoot, before.futureRoot);

    const repeatedState = detect(home);
    assert.equal(repeatedState.bridgeState.managedProviderId, FIXED_PROVIDER_ID);
    const repeated = planAdd(home, { state: repeatedState });
    assert.equal(repeated.noChange, true);
    assert.deepEqual(repeated.changes, []);
    const backupCount = repeatedState.bridgeState.backups.length;
    const repeatedResult = applyZcodePlan(repeated);
    assert.equal(repeatedResult.changed, false);
    assert.equal(detect(home).bridgeState.backups.length, backupCount);
    assert.deepEqual(fs.readFileSync(fixture.cli), fixture.cliBytes);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testAbsentConfigAndModes() {
  const home = tmpHome("absent");
  try {
    const cli = cliConfigPath(home);
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, '{"plugins":{"keep":true}}\n');
    const cliBytes = fs.readFileSync(cli);
    const state = detect(home);
    assert.equal(state.exists, false);
    assert.deepEqual(state.document, { provider: {} });
    const result = applyZcodePlan(planAdd(home, { state }));
    assert.equal(result.backup, null);
    assertPrivate(configPath(home));
    assert.deepEqual(fs.readFileSync(cli), cliBytes);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testUnsupportedAndMalformedArePreviewOnly() {
  const cases = [
    { name: "unknown-version", version: "4.0.0", document: existingDocument() },
    { name: "root-array", version: "3.3.6", document: [] },
    { name: "provider-array", version: "3.3.6", document: { provider: [] } },
  ];
  for (const fixtureCase of cases) {
    const home = tmpHome(fixtureCase.name);
    try {
      const fixture = writeFixture(home, fixtureCase.document);
      const bytes = fs.readFileSync(fixture.file);
      const state = detect(home, { version: fixtureCase.version });
      assert.equal(state.previewOnly, true, fixtureCase.name);
      const plan = planAdd(home, { state });
      assert.equal(plan.previewOnly, true, fixtureCase.name);
      assert.throws(() => applyZcodePlan(plan), /preview-only/i);
      assert.deepEqual(fs.readFileSync(fixture.file), bytes);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  const malformedHome = tmpHome("malformed");
  try {
    const file = configPath(malformedHome);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{invalid-json");
    const state = detect(malformedHome);
    assert.equal(state.previewOnly, true);
    assert.equal(state.document, null);
  } finally {
    fs.rmSync(malformedHome, { recursive: true, force: true });
  }
}

function testAdoptableAndAmbiguousMatches() {
  const adoptHome = tmpHome("adopt");
  try {
    const document = existingDocument();
    document.provider.adoptable = {
      name: "LLM Coding Bridge",
      kind: "openai-compatible",
      source: "custom",
      options: { baseURL: "http://127.0.0.1:37629/v1", apiKey: "old-local-token" },
      models: {},
    };
    writeFixture(adoptHome, document);
    const plan = planAdd(adoptHome);
    assert.equal(plan.managedProviderId, "adoptable");
    assert.deepEqual(plan.changes, [{ op: "replace", path: "/provider/adoptable" }]);
    applyZcodePlan(plan);
    assert.equal(detect(adoptHome).bridgeState.managedProviderId, "adoptable");
  } finally {
    fs.rmSync(adoptHome, { recursive: true, force: true });
  }

  const ambiguousHome = tmpHome("ambiguous");
  try {
    const document = existingDocument();
    for (const id of ["candidate-a", "candidate-b"]) {
      document.provider[id] = {
        name: "LLM Coding Bridge",
        kind: "openai-compatible",
        source: "custom",
        options: { baseURL: "http://127.0.0.1:37629/v1", apiKey: "old-local-token" },
        models: {},
      };
    }
    writeFixture(ambiguousHome, document);
    const plan = planAdd(ambiguousHome);
    assert.equal(plan.previewOnly, true);
    assert.match(plan.warnings.join(" "), /ambiguous/i);
  } finally {
    fs.rmSync(ambiguousHome, { recursive: true, force: true });
  }
}

function testConcurrentChangeAndSymlinkPreservation() {
  const concurrentHome = tmpHome("concurrent");
  try {
    const fixture = writeFixture(concurrentHome);
    const plan = planAdd(concurrentHome);
    const concurrent = `${JSON.stringify({ ...existingDocument(), concurrent: "keep" }, null, 2)}\n`;
    fs.writeFileSync(fixture.file, concurrent);
    assert.throws(() => applyZcodePlan(plan), /changed since it was read/i);
    assert.equal(fs.readFileSync(fixture.file, "utf8"), concurrent);
  } finally {
    fs.rmSync(concurrentHome, { recursive: true, force: true });
  }

  for (const kind of ["relative", "absolute"]) {
    const home = tmpHome(`symlink-${kind}`);
    try {
      const requested = configPath(home);
      const target = path.join(home, "shared", `${kind}.json`);
      fs.mkdirSync(path.dirname(requested), { recursive: true });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(existingDocument(), null, 2)}\n`);
      fs.symlinkSync(kind === "relative" ? path.relative(path.dirname(requested), target) : target, requested);
      applyZcodePlan(planAdd(home));
      assert.equal(fs.lstatSync(requested).isSymbolicLink(), true);
      assert.ok(JSON.parse(fs.readFileSync(target, "utf8")).provider[FIXED_PROVIDER_ID]);
      assertPrivate(target);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  const nonFileHome = tmpHome("non-file-link");
  try {
    const requested = configPath(nonFileHome);
    const target = path.join(nonFileHome, "directory-target");
    fs.mkdirSync(path.dirname(requested), { recursive: true });
    fs.mkdirSync(target);
    fs.symlinkSync(target, requested);
    const state = detect(nonFileHome);
    assert.equal(state.previewOnly, true);
    assert.match(state.warnings.join(" "), /regular file/i);
  } finally {
    fs.rmSync(nonFileHome, { recursive: true, force: true });
  }

  const danglingHome = tmpHome("dangling-link");
  try {
    const requested = configPath(danglingHome);
    fs.mkdirSync(path.dirname(requested), { recursive: true });
    fs.symlinkSync("missing-target.json", requested);
    const state = detect(danglingHome);
    assert.equal(state.previewOnly, true);
    assert.match(state.warnings.join(" "), /regular file/i);
  } finally {
    fs.rmSync(danglingHome, { recursive: true, force: true });
  }
}

function testPostWriteVerificationFailureRestoresBothFiles() {
  const newStateHome = tmpHome("verify-rollback-new-state");
  try {
    const fixture = writeFixture(newStateHome);
    const configBefore = fs.readFileSync(fixture.file);
    const plan = planAdd(newStateHome);
    plan.unmanagedHash = "force-verification-failure";
    assert.throws(() => applyZcodePlan(plan), /unrelated ZCode configuration/i);
    assert.deepEqual(fs.readFileSync(fixture.file), configBefore);
    assert.equal(fs.existsSync(statePath(newStateHome)), false);
  } finally {
    fs.rmSync(newStateHome, { recursive: true, force: true });
  }

  const existingStateHome = tmpHome("verify-rollback-existing-state");
  try {
    const fixture = writeFixture(existingStateHome);
    applyZcodePlan(planAdd(existingStateHome));
    const configBefore = fs.readFileSync(fixture.file);
    const stateBefore = fs.readFileSync(statePath(existingStateHome));
    const plan = planAdd(existingStateHome, {
      state: detect(existingStateHome),
      config: bridgeConfig(["coding-fast", "coding-strong", "coding-long"]),
    });
    plan.unmanagedHash = "force-verification-failure";
    assert.throws(() => applyZcodePlan(plan), /unrelated ZCode configuration/i);
    assert.deepEqual(fs.readFileSync(fixture.file), configBefore);
    assert.deepEqual(fs.readFileSync(statePath(existingStateHome)), stateBefore);
  } finally {
    fs.rmSync(existingStateHome, { recursive: true, force: true });
  }
}

function testRemoveAndExplicitRollback() {
  const home = tmpHome("remove-rollback");
  try {
    const fixture = writeFixture(home);
    applyZcodePlan(planAdd(home), { now: new Date("2026-07-22T03:00:00Z") });
    const addedState = detect(home);
    const removePlan = planZcodeChange({ action: "remove", config: bridgeConfig(), home, state: addedState });
    assert.deepEqual(removePlan.changes, [{ op: "remove", path: `/provider/${FIXED_PROVIDER_ID}` }]);
    const removed = applyZcodePlan(removePlan, { now: new Date("2026-07-22T03:00:01Z") });
    assert.equal(JSON.parse(fs.readFileSync(fixture.file, "utf8")).provider[FIXED_PROVIDER_ID], undefined);
    assert.ok(removed.backup);

    const rollbackPlan = planZcodeRollback({ home, state: detect(home), backup: removed.backup });
    assert.equal(rollbackPlan.previewOnly, false);
    assert.deepEqual(rollbackPlan.changes, [{ op: "replace", path: "/" }]);
    const rollback = applyZcodeRollback(rollbackPlan, { now: new Date("2026-07-22T03:00:02Z") });
    assert.equal(rollback.changed, true);
    assert.ok(JSON.parse(fs.readFileSync(fixture.file, "utf8")).provider[FIXED_PROVIDER_ID]);
    assertPrivate(rollback.backup);

    assert.throws(
      () => planZcodeRollback({ home, state: detect(home), backup: path.join(home, "not-recorded.json") }),
      /bridge-created backup/i
    );
    assert.deepEqual(fs.readFileSync(fixture.cli), fixture.cliBytes);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  const missingStateHome = tmpHome("missing-state");
  try {
    writeFixture(missingStateHome);
    const state = detect(missingStateHome);
    const plan = planZcodeChange({ action: "remove", config: bridgeConfig(), home: missingStateHome, state });
    assert.equal(plan.noChange, true);
    assert.match(plan.warnings.join(" "), /managed state/i);
  } finally {
    fs.rmSync(missingStateHome, { recursive: true, force: true });
  }
}

function main() {
  testStatusSanitization();
  testAddPreservesEverythingAndIsIdempotent();
  testAbsentConfigAndModes();
  testUnsupportedAndMalformedArePreviewOnly();
  testAdoptableAndAmbiguousMatches();
  testConcurrentChangeAndSymlinkPreservation();
  testPostWriteVerificationFailureRestoresBothFiles();
  testRemoveAndExplicitRollback();
  console.log("zcode client tests passed");
}

try {
  main();
} catch (error) {
  console.error(error.stack || String(error));
  process.exitCode = 1;
}
