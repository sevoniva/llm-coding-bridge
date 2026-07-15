"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { configureClaudeCode, configureCodexDesktop } = require("../lib/client-setup");
const { createCodexProfile } = require("../lib/codex-profile");
const { loadConfig, localUrl } = require("../lib/config");
const { startServer } = require("../lib/server");

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

function tmpHome(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lcb-security-${name}-`));
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function assertMode(file, expected) {
  assert.equal(mode(file), expected, `${file} must have mode ${expected.toString(8)}`);
}

function config(localToken = "local-secret") {
  return {
    path: "/tmp/bridge.config.json",
    server: { host: "127.0.0.1", port: 37629, localToken },
    upstreams: [{ name: "Example", baseUrl: "https://api.example.com/v1", model: "example-model", apiKeyEnv: "EXAMPLE_API_KEY" }],
    defaultUpstream: { name: "Example", baseUrl: "https://api.example.com/v1", model: "example-model", apiKeyEnv: "EXAMPLE_API_KEY" },
  };
}

function runCli(cli, args, input) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(input);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

async function testBracketedIpv6Listener() {
  const directory = tmpHome("ipv6-listener");
  const configPath = path.join(directory, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    server: { host: "[::1]", port: 0 },
    upstream: {
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
      apiKeyEnv: "EXAMPLE_API_KEY",
    },
  }));

  const loaded = loadConfig(configPath);
  assert.equal(loaded.server.host, "::1");
  const server = startServer(loaded);
  try {
    if (!server.listening) {
      await new Promise((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    const address = server.address();
    assert.equal(address.address, "::1");
    const listeningConfig = { ...loaded, server: { ...loaded.server, port: address.port } };
    assert.equal(localUrl(listeningConfig, "/v1"), `http://[::1]:${address.port}/v1`);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const previousUmask = process.umask(0o022);
  const fixedDate = new Date("2026-07-15T01:02:03Z");
  try {
    const initHome = tmpHome("init");
    const initPath = path.join(initHome, ".llm-coding-bridge", "config.json");
    const cli = path.join(__dirname, "..", "bin", "llm-coding-bridge.js");
    const init = await runCli(cli, ["init", "--out", initPath, "--home", initHome, "--no-doctor"], [
      "127.0.0.1",
      "37629",
      "Example Provider",
      "https://api.example.com/v1",
      "example-model",
      "local",
      "EXAMPLE_API_KEY",
      "",
      "0",
      "local-secret",
      "",
      "",
      "",
    ].join("\n"));
    assert.equal(init.code, 0, init.stderr || init.stdout);
    assertMode(path.dirname(initPath), PRIVATE_DIRECTORY_MODE);
    assertMode(initPath, PRIVATE_FILE_MODE);
    assert.equal(JSON.parse(fs.readFileSync(initPath, "utf8")).server.localToken, "local-secret");
    await testBracketedIpv6Listener();

    for (const field of ["timeoutMs", "maxResponseBytes", "maxSseEventBytes"]) {
      const invalidPath = path.join(initHome, `invalid-${field}.json`);
      fs.writeFileSync(invalidPath, JSON.stringify({
        server: { host: "127.0.0.1", port: 37629 },
        upstream: {
          baseUrl: "https://api.example.com/v1",
          model: "example-model",
          apiKeyEnv: "EXAMPLE_API_KEY",
          [field]: 0,
        },
      }));
      const invalid = await runCli(cli, ["status", "--config", invalidPath], "");
      assert.notEqual(invalid.code, 0);
      assert.match(invalid.stderr, new RegExp(`upstream\\.${field} must be a positive integer\\.`));
    }

    const claudeHome = tmpHome("claude");
    const claudeFirst = configureClaudeCode(config(), claudeHome);
    assertMode(path.dirname(claudeFirst.file), PRIVATE_DIRECTORY_MODE);
    assertMode(claudeFirst.file, PRIVATE_FILE_MODE);
    fs.chmodSync(claudeFirst.file, 0o644);
    const claudeSecond = configureClaudeCode(config(), claudeHome, { now: fixedDate });
    assertMode(claudeSecond.file, PRIVATE_FILE_MODE);
    assertMode(claudeSecond.backup, PRIVATE_FILE_MODE);

    const symlinkHome = tmpHome("claude-symlink");
    const symlinkDirectory = path.join(symlinkHome, ".claude");
    const symlinkTarget = path.join(symlinkHome, "shared-settings.json");
    const symlinkFile = path.join(symlinkDirectory, "settings.json");
    fs.mkdirSync(symlinkDirectory, { recursive: true });
    fs.writeFileSync(symlinkTarget, '{"env":{"KEEP":"yes"}}\n');
    fs.symlinkSync(symlinkTarget, symlinkFile);
    const symlinkResult = configureClaudeCode(config(), symlinkHome, { now: fixedDate });
    assert.equal(fs.lstatSync(symlinkFile).isSymbolicLink(), true);
    assert.equal(JSON.parse(fs.readFileSync(symlinkTarget, "utf8")).env.KEEP, "yes");
    assertMode(symlinkTarget, PRIVATE_FILE_MODE);
    assertMode(symlinkResult.backup, PRIVATE_FILE_MODE);

    const desktopHome = tmpHome("desktop");
    const desktopFirst = configureCodexDesktop(config(), desktopHome);
    assertMode(path.dirname(desktopFirst.file), PRIVATE_DIRECTORY_MODE);
    assertMode(path.dirname(desktopFirst.catalogPath), PRIVATE_DIRECTORY_MODE);
    assertMode(desktopFirst.file, PRIVATE_FILE_MODE);
    assertMode(desktopFirst.catalogPath, PRIVATE_FILE_MODE);
    fs.chmodSync(desktopFirst.file, 0o644);
    fs.chmodSync(desktopFirst.catalogPath, 0o644);
    const desktopSecond = configureCodexDesktop(config(), desktopHome, { now: fixedDate });
    assertMode(desktopSecond.file, PRIVATE_FILE_MODE);
    assertMode(desktopSecond.catalogPath, PRIVATE_FILE_MODE);
    assertMode(desktopSecond.backup, PRIVATE_FILE_MODE);
    assertMode(desktopSecond.catalogBackup, PRIVATE_FILE_MODE);

    const profileHome = tmpHome("profile");
    const profileFirst = createCodexProfile(config(), "bridge", profileHome, false);
    assertMode(path.dirname(profileFirst.profilePath), PRIVATE_DIRECTORY_MODE);
    assertMode(path.dirname(profileFirst.catalogPath), PRIVATE_DIRECTORY_MODE);
    assertMode(profileFirst.profilePath, PRIVATE_FILE_MODE);
    assertMode(profileFirst.catalogPath, PRIVATE_FILE_MODE);
    fs.chmodSync(profileFirst.profilePath, 0o644);
    fs.chmodSync(profileFirst.catalogPath, 0o644);
    const profileSecond = createCodexProfile(config(), "bridge", profileHome, true, { now: fixedDate });
    assertMode(profileSecond.profilePath, PRIVATE_FILE_MODE);
    assertMode(profileSecond.catalogPath, PRIVATE_FILE_MODE);
    for (const backup of profileSecond.backups) assertMode(backup, PRIVATE_FILE_MODE);

    const clientProfileHome = tmpHome("client-profile");
    const clientUpstream = {
      name: "Example",
      baseUrl: "https://api.example.com/v1",
      model: "example-model",
      apiKeySource: "client",
    };
    const clientConfig = {
      path: "/tmp/client-bridge.config.json",
      server: { host: "127.0.0.1", port: 37629 },
      upstreams: [clientUpstream],
      defaultUpstream: clientUpstream,
    };
    process.env.LLM_CODING_BRIDGE_CLIENT_API_KEY = "synthetic-upstream-key";
    const clientProfile = createCodexProfile(clientConfig, "client", clientProfileHome, false);
    assertMode(clientProfile.profilePath, PRIVATE_FILE_MODE);
    assert.match(fs.readFileSync(clientProfile.profilePath, "utf8"), /synthetic-upstream-key/);
  } finally {
    process.umask(previousUmask);
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
