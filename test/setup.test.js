"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadConfig } = require("../lib/config");
const { loadSetupProfile, runSetup, validateSetupProfile } = require("../lib/setup");

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lcb-setup-${name}-`));
}

function profile(clients = ["zcode"]) {
  return {
    provider: { name: "Shared Provider", baseUrl: "https://api.example.com/v1" },
    models: [
      {
        alias: "coding-fast",
        upstreamModel: "provider-model-id-a",
        credential: { source: "env", env: "MODEL_FAST_API_KEY" },
        capabilities: { contextWindow: 131072, inputModalities: ["text", "image"], reasoning: true },
      },
      {
        alias: "coding-strong",
        upstreamModel: "provider-model-id-b",
        credential: {
          source: "command",
          command: { command: "/usr/bin/security", args: ["find-generic-password", "-s", "synthetic-service", "-w"] },
        },
        reliabilityPolicy: "long-thinking",
      },
    ],
    clients,
    service: "none",
    probe: "all",
  };
}

function writeZcodeFixture(home) {
  const file = path.join(home, ".zcode", "v2", "config.json");
  const cli = path.join(home, ".zcode", "cli", "config.json");
  const unrelated = {
    name: "Keep Me",
    kind: "openai-compatible",
    source: "custom",
    options: { baseURL: "https://keep.example/v1", apiKey: "synthetic-unrelated-key" },
    models: { keep: { future: true } },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ futureRoot: true, provider: { unrelated } }, null, 2)}\n`, { mode: 0o644 });
  fs.writeFileSync(cli, '{"mcp":{"keep":true}}\n');
  return { file, cli, unrelated: JSON.stringify(unrelated), cliBytes: fs.readFileSync(cli) };
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

async function testIdempotentProfileSetup() {
  const home = tmpHome("idempotent");
  const zcode = writeZcodeFixture(home);
  const configFile = path.join(home, ".llm-coding-bridge", "config.json");
  const probes = [];
  const options = {
    home,
    configPath: configFile,
    zcodeVersion: "3.3.6",
    localTokenFactory: () => "synthetic-stable-local-token",
    now: new Date("2026-07-22T04:05:06Z"),
    async probeAllModels(config) {
      probes.push(config.routes.map((route) => route.alias));
      return config.routes.map((route) => ({ alias: route.alias, ok: true, category: "success", code: "OK", elapsedMs: 1 }));
    },
  };
  try {
    const first = await runSetup(profile(), options);
    assert.equal(first.configChanged, true);
    assert.equal(first.zcode.changed, true);
    assert.equal(first.probes.every((result) => result.ok), true);
    const firstConfigBytes = fs.readFileSync(configFile);
    const firstZcodeBytes = fs.readFileSync(zcode.file);
    const loaded = loadConfig(configFile);
    assert.equal(loaded.version, 2);
    assert.deepEqual(loaded.routes.map((route) => ({
      alias: route.alias,
      upstreamModel: route.upstreamModel,
      source: route.credential.source,
    })), [
      { alias: "coding-fast", upstreamModel: "provider-model-id-a", source: "env" },
      { alias: "coding-strong", upstreamModel: "provider-model-id-b", source: "command" },
    ]);
    assert.equal(loaded.server.localToken, "synthetic-stable-local-token");
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    const zcodeDocument = JSON.parse(firstZcodeBytes);
    assert.equal(JSON.stringify(zcodeDocument.provider.unrelated), zcode.unrelated);
    assert.equal(zcodeDocument.futureRoot, true);
    assert.deepEqual(fs.readFileSync(zcode.cli), zcode.cliBytes);
    assert.ok(first.zcode.backup);
    assert.equal(fs.statSync(first.zcode.backup).mode & 0o777, 0o600);

    const serialized = Buffer.concat([firstConfigBytes, firstZcodeBytes]).toString("utf8");
    assert.doesNotMatch(serialized, /synthetic-env-value|synthetic-command-output|provider-real-key/);

    const second = await runSetup(profile(), options);
    assert.equal(second.configChanged, false);
    assert.equal(second.zcode.changed, false);
    assert.deepEqual(fs.readFileSync(configFile), firstConfigBytes);
    assert.deepEqual(fs.readFileSync(zcode.file), firstZcodeBytes);
    assert.deepEqual(fs.readFileSync(zcode.cli), zcode.cliBytes);
    assert.deepEqual(probes, [
      ["coding-fast", "coding-strong"],
      ["coding-fast", "coding-strong"],
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function testProfileValidationAndLoading() {
  assert.deepEqual(validateSetupProfile(profile([])).clients, []);
  for (const invalid of [
    { ...profile([]), apiKey: "literal-key" },
    { ...profile([]), script: "do something" },
    { ...profile([]), clients: ["unknown"] },
    { ...profile([]), models: [{ ...profile([]).models[0], alias: "unsafe alias" }] },
    { ...profile([]), models: [{ ...profile([]).models[0], credential: { source: "env", env: "BAD-NAME" } }] },
  ]) {
    assert.throws(() => validateSetupProfile(invalid), /profile|unsupported|alias|credential|client/i);
  }

  const home = tmpHome("profile-load");
  try {
    const file = path.join(home, "setup.json");
    fs.writeFileSync(file, `${JSON.stringify(profile([]), null, 2)}\n`);
    assert.deepEqual(loadSetupProfile(file), validateSetupProfile(profile([])));
    fs.writeFileSync(file, "{invalid");
    assert.throws(() => loadSetupProfile(file), /valid JSON/i);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function testProfileCliWithoutClientMutation() {
  const home = tmpHome("cli-profile");
  try {
    const profileFile = path.join(home, "setup.json");
    fs.writeFileSync(profileFile, `${JSON.stringify({ ...profile([]), probe: "none" }, null, 2)}\n`);
    const result = await runCli(["setup", "--profile", profileFile, "--home", home]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /setup complete/i);
    const file = path.join(home, ".llm-coding-bridge", "config.json");
    assert.equal(loadConfig(file).version, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-stable-local-token|provider-model-id-a|provider-model-id-b/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function testConcurrentBridgeConfigChangeIsPreserved() {
  const home = tmpHome("concurrent");
  const configFile = path.join(home, ".llm-coding-bridge", "config.json");
  const noClients = { ...profile([]), probe: "none" };
  try {
    await runSetup(noClients, {
      home,
      configPath: configFile,
      localTokenFactory: () => "synthetic-stable-local-token",
    });
    const current = JSON.parse(fs.readFileSync(configFile, "utf8"));
    const concurrent = `${JSON.stringify({ ...current, operatorNote: "keep-concurrent-change" }, null, 2)}\n`;
    await assert.rejects(
      () => runSetup({
        ...noClients,
        models: [...noClients.models, {
          alias: "coding-long",
          upstreamModel: "provider-model-id-c",
          credential: { source: "env", env: "MODEL_LONG_API_KEY" },
        }],
      }, {
        home,
        configPath: configFile,
        beforeConfigWrite() {
          fs.writeFileSync(configFile, concurrent);
        },
      }),
      /changed since it was read/i
    );
    assert.equal(fs.readFileSync(configFile, "utf8"), concurrent);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  testProfileValidationAndLoading();
  await testIdempotentProfileSetup();
  await testProfileCliWithoutClientMutation();
  await testConcurrentBridgeConfigChangeIsPreserved();
  console.log("setup tests passed");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
