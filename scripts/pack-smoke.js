"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { powershellPath } = require("../lib/windows");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-npm-install-中文 space-"));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run through npm run pack:smoke.");
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60000, shell: false, windowsHide: true, ...options });
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
  return result.stdout;
}
try {
  const pack = JSON.parse(run(process.execPath, [npmCli, "pack", "--json", "--pack-destination", temp]))[0];
  const files = new Set(pack.files.map((file) => file.path));
  for (const required of ["docs/getting-started.zh-CN.md", "docs/guided-setup.zh-CN.md", "templates/simple.config.example.json", "templates/setup.example.json", "templates/bridge.config.example.json", "scripts/windows-service.ps1", "scripts/windows-security.ps1", "scripts/windows-zcode.ps1", "scripts/service-runner.js"]) {
    assert.ok(files.has(required), `npm package is missing ${required}`);
  }
  const prefix = path.join(temp, "npm prefix");
  run(process.execPath, [npmCli, "install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", path.join(temp, pack.filename)]);
  const moduleRoot = path.join(prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules", "@sevoniva", "llm-coding-bridge");
  const cli = path.join(moduleRoot, "bin", "llm-coding-bridge.js");
  const home = path.join(temp, "user home");
  fs.mkdirSync(home);
  const simpleFolder = path.join(home, "simple files");
  run(process.execPath, [cli, "init-files", "--out", simpleFolder, "--home", home]);
  assert.ok(fs.existsSync(path.join(simpleFolder, process.platform === "win32" ? "restart.cmd" : "restart.command")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(simpleFolder, "config.json"), "utf8")).upstream.apiKey, "YOUR_API_KEY");
  const template = JSON.parse(run(process.execPath, [cli, "template", "setup"]));
  template.models[0].credential = { source: "env", env: "SYNTHETIC_KEY" };
  template.service = "none";
  template.probe = "none";
  const profile = path.join(temp, "setup.json");
  fs.writeFileSync(profile, `\uFEFF${JSON.stringify(template)}`);
  run(process.execPath, [cli, "setup", "--profile", profile, "--home", home]);
  run(process.execPath, [cli, "config", "validate", "--home", home], { cwd: temp });
  const shim = path.join(prefix, ...(process.platform === "win32" ? ["llm-coding-bridge.cmd"] : ["bin", "llm-coding-bridge"]));
  const help = process.platform === "win32"
    ? run(powershellPath(), ["-NoProfile", "-NonInteractive", "-Command", `& '${shim.replace(/'/g, "''")}' --help; exit $LASTEXITCODE`])
    : run(shim, ["--help"]);
  assert.match(help, /credential set/);
  console.log("Packed npm package installs, configures and runs through its global command.");
} finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
