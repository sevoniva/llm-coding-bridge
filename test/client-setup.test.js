"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { configureClaudeCode, configureCodexDesktop } = require("../lib/client-setup");
const { createCodexProfile } = require("../lib/codex-profile");

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lcb-${name}-`));
}

function testConfig(localToken) {
  return {
    path: "/tmp/bridge.config.json",
    server: { host: "127.0.0.1", port: 37629, ...(localToken ? { localToken } : {}) },
    upstreams: [{ name: "Example", baseUrl: "https://api.example.com/v1", model: "example-model", apiKeyEnv: "EXAMPLE_API_KEY" }],
    defaultUpstream: { name: "Example", baseUrl: "https://api.example.com/v1", model: "example-model", apiKeyEnv: "EXAMPLE_API_KEY" },
  };
}

function runCli(cli, args, input = "", env = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(input);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

async function main() {
  const fixedDate = new Date("2026-07-04T01:02:03Z");

  const claudeHome = tmpHome("claude");
  const claudeSettings = path.join(claudeHome, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(claudeSettings, `${JSON.stringify({ theme: "dark", env: { KEEP: "yes", ANTHROPIC_BASE_URL: "old" } }, null, 2)}\n`);
  const claude = configureClaudeCode(testConfig("client-token"), claudeHome, { now: fixedDate });
  assert.equal(claude.file, claudeSettings);
  assert.equal(claude.backup, `${claudeSettings}.bak-20260704-010203`);
  assert.equal(JSON.parse(fs.readFileSync(claude.backup, "utf8")).env.ANTHROPIC_BASE_URL, "old");
  const mergedClaude = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(mergedClaude.theme, "dark");
  assert.equal(mergedClaude.env.KEEP, "yes");
  assert.equal(mergedClaude.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:37629");
  assert.equal(mergedClaude.env.ANTHROPIC_AUTH_TOKEN, "client-token");
  assert.equal(mergedClaude.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "example-model");
  assert.equal(mergedClaude.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "example-model");
  assert.equal(mergedClaude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "example-model");

  fs.writeFileSync(claude.backup, "collision");
  assert.throws(
    () => configureClaudeCode(testConfig(), claudeHome, { now: fixedDate }),
    /backup/i
  );
  assert.equal(JSON.parse(fs.readFileSync(claudeSettings, "utf8")).env.ANTHROPIC_AUTH_TOKEN, "client-token");

  const profileHome = tmpHome("profile");
  createCodexProfile(testConfig(), "bridge", profileHome, false, { now: fixedDate });
  const profilePath = path.join(profileHome, ".codex", "bridge.config.toml");
  const catalogPath = path.join(profileHome, ".llm-coding-bridge", "codex-model-catalog.json");
  assert.match(fs.readFileSync(profilePath, "utf8"), /model = "example-model"/);
  createCodexProfile(testConfig(), "bridge", profileHome, true, { now: fixedDate });
  assert.ok(fs.existsSync(`${profilePath}.bak-20260704-010203`));
  assert.ok(fs.existsSync(`${catalogPath}.bak-20260704-010203`));

  const desktopHome = tmpHome("desktop");
  const desktopConfig = path.join(desktopHome, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(desktopConfig), { recursive: true });
  fs.writeFileSync(desktopConfig, "notify = true\n[tools]\nweb = true\n");
  const desktop = configureCodexDesktop(testConfig(), desktopHome, { now: fixedDate });
  assert.equal(desktop.backup, `${desktopConfig}.bak-20260704-010203`);
  const desktopText = fs.readFileSync(desktopConfig, "utf8");
  assert.match(desktopText, /model_provider = "llm-coding-bridge"/);
  assert.match(desktopText, /model_catalog_json = /);
  assert.match(desktopText, /notify = true/);
  assert.match(desktopText, /\[tools\]\nweb = true/);

  const cliHome = tmpHome("cli");
  const cli = path.join(__dirname, "..", "bin", "llm-coding-bridge.js");
  const initPath = path.join(cliHome, "config.json");
  const init = await runCli(cli, ["init", "--out", initPath, "--home", cliHome, "--no-doctor"], [
    "127.0.0.1",
    "37629",
    "Example Provider",
    "https://api.example.com/v1",
    "example-model",
    "",
    "EXAMPLE_API_KEY",
    "",
    "0",
    "",
    "",
  ].join("\n"), { EXAMPLE_API_KEY: "do-not-print-this" });
  assert.equal(init.code, 0, init.stderr || init.stdout);
  assert.match(init.stdout, /Manual setup/);
  assert.doesNotMatch(init.stdout + init.stderr, /do-not-print-this/);
  assert.equal(fs.existsSync(path.join(cliHome, ".claude", "settings.json")), false);
  assert.equal(fs.existsSync(path.join(cliHome, ".codex", "bridge.config.toml")), false);
  assert.equal(fs.existsSync(path.join(cliHome, ".codex", "config.toml")), false);

  const clientKeyHome = tmpHome("client-key");
  const clientKeyInitPath = path.join(clientKeyHome, "config.json");
  const clientKeyInit = await runCli(cli, ["init", "--out", clientKeyInitPath, "--home", clientKeyHome, "--no-doctor"], [
    "127.0.0.1",
    "37629",
    "Example Provider",
    "https://api.example.com/v1",
    "example-model",
    "client",
    "0",
    "",
    "",
  ].join("\n"), { LLM_CODING_BRIDGE_CLIENT_API_KEY: "do-not-print-client-key" });
  assert.equal(clientKeyInit.code, 0, clientKeyInit.stderr || clientKeyInit.stdout);
  assert.match(clientKeyInit.stdout, /Client requests must include the upstream API key/);
  assert.match(clientKeyInit.stdout, /ANTHROPIC_AUTH_TOKEN=<upstream-api-key>/);
  assert.doesNotMatch(clientKeyInit.stdout, /ANTHROPIC_AUTH_TOKEN=local/);
  assert.doesNotMatch(clientKeyInit.stdout + clientKeyInit.stderr, /do-not-print-client-key/);
  const clientKeyConfig = JSON.parse(fs.readFileSync(clientKeyInitPath, "utf8"));
  assert.equal(clientKeyConfig.upstream.apiKeySource, "client");
  assert.equal("apiKeyEnv" in clientKeyConfig.upstream, false);
  assert.equal("apiKeyCommand" in clientKeyConfig.upstream, false);

  const guardedHome = tmpHome("guarded");
  const guardedInitPath = path.join(guardedHome, "config.json");
  const guarded = await runCli(cli, ["init", "--out", guardedInitPath, "--home", guardedHome, "--no-doctor"], [
    "127.0.0.1",
    "37629",
    "Example Provider",
    "https://api.example.com/v1",
    "example-model",
    "",
    "EXAMPLE_API_KEY",
    "",
    "0",
    "",
    "y",
    "n",
    "n",
    "",
  ].join("\n"));
  assert.equal(guarded.code, 0, guarded.stderr || guarded.stdout);
  assert.match(guarded.stdout, /changes the default Codex Desktop provider/);
  assert.equal(fs.existsSync(path.join(guardedHome, ".codex", "config.toml")), false);

  const codexHome = tmpHome("codex-init");
  const codexInitPath = path.join(codexHome, "config.json");
  const codexInit = await runCli(cli, ["init", "--out", codexInitPath, "--home", codexHome, "--no-doctor"], [
    "127.0.0.1",
    "37629",
    "Example Provider",
    "https://api.example.com/v1",
    "example-model",
    "",
    "EXAMPLE_API_KEY",
    "",
    "0",
    "",
    "y",
    "n",
    "y",
    "n",
  ].join("\n"));
  assert.equal(codexInit.code, 0, codexInit.stderr || codexInit.stdout);
  assert.ok(fs.existsSync(path.join(codexHome, ".codex", "bridge.config.toml")));
  assert.equal(fs.existsSync(path.join(codexHome, ".codex", "config.toml")), false);
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
