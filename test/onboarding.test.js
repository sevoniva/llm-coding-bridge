"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { runSetup, validateSetupProfile } = require("../lib/setup");
const { loadConfig } = require("../lib/config");
const { servicePaths } = require("../lib/service");

const cli = path.join(__dirname, "..", "bin", "llm-coding-bridge.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-onboarding-中文 space-"));
const config = path.join(home, "custom config.json");
function invoke(args) {
  return spawnSync(process.execPath, [cli, ...args, "--home", home], { encoding: "utf8", cwd: home, timeout: 30000 });
}
async function main() {
  try {
    const template = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "templates", "setup.example.json"), "utf8"));
    validateSetupProfile(template);
    const profile = { ...template, clients: ["codex", "claude-code"], service: "none", probe: "none" };
    let reads = 0;
    const store = {
      read(alias) { assert.equal(alias, "coding"); reads++; return "synthetic-secret-value"; },
      descriptor() { return { source: "env", env: "MODEL_KEY" }; },
    };
    const first = await runSetup(profile, { home, configPath: config, credentialStore: store });
    assert.equal(reads, 1);
    assert.equal(loadConfig(config).version, 2);
    assert.equal(loadConfig(config).routes[0].alias, "coding");
    assert.doesNotMatch(fs.readFileSync(config, "utf8"), /synthetic-secret-value|"source": "stored"/);
    assert.ok(fs.existsSync(first.clients.codex.file));
    assert.ok(fs.existsSync(first.clients["claude-code"].file));
    const token = loadConfig(config).server.localToken;
    const second = await runSetup(profile, { home, configPath: config, credentialStore: store });
    assert.equal(second.configChanged, false);
    assert.ok(second.clients.codex.backup);
    assert.equal(loadConfig(config).server.localToken, token);

    const profileFile = path.join(home, "setup.json");
    fs.writeFileSync(profileFile, `\uFEFF${JSON.stringify({ ...profile, clients: [], models: [{ ...profile.models[0], credential: { source: "env", env: "MODEL_KEY" } }] })}\r\n`);
    const setup = invoke(["setup", "--profile", profileFile, "--config", config]);
    assert.equal(setup.status, 0, setup.stderr);
    fs.writeFileSync(config, `\uFEFF${fs.readFileSync(config, "utf8")}`);
    assert.equal(invoke(["config", "validate", "--config", config]).status, 0);
    const view = invoke(["config", "show", "--effective", "--config", config]);
    assert.equal(view.status, 0, view.stderr);
    assert.equal(JSON.parse(view.stdout).configSource, config);
    assert.doesNotMatch(view.stdout, new RegExp(token));
    assert.equal(invoke(["config", "path", "--config", config]).stdout.trim(), config);
    const localConfig = path.join(home, "llm-coding-bridge.config.json");
    fs.writeFileSync(localConfig, "{}");
    assert.equal(fs.realpathSync(invoke(["config", "path"]).stdout.trim()), fs.realpathSync(localConfig));

    // A custom installed config must remain selected when commands run from another cwd.
    fs.mkdirSync(path.dirname(servicePaths(home).manifest), { recursive: true });
    fs.writeFileSync(servicePaths(home).manifest, JSON.stringify({ configPath: config }));
    const status = invoke(["status"]);
    assert.ok(status.stdout.includes(config));
    assert.ok(!status.stdout.includes(`[OK] config ${localConfig}`));

    fs.writeFileSync(config, "{invalid");
    const invalid = invoke(["config", "validate", "--config", config]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /UTF-8 JSON/);
    const missingTarget = path.join(home, "missing-credential.json");
    await assert.rejects(() => runSetup(profile, { home, configPath: missingTarget, credentialStore: { read() { throw new Error("Missing stored key"); } } }), /Missing stored key/);
    assert.equal(fs.existsSync(missingTarget), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
  console.log("onboarding tests passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
