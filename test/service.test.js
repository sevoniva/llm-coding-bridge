"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { installService, restartService, stopService, uninstallService, serviceStatus, installedServiceConfig, servicePaths, plistPath, taskName, windowsLauncher } = require("../lib/service");

for (const platform of ["darwin", "win32"]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-service-中文 space & '-"));
  const config = path.join(home, "bridge config.json");
  fs.writeFileSync(config, "{}");
  const calls = [];
  const options = { platform, home, uid: 123, nodePath: process.execPath, run(command, args, settings) {
    calls.push({ command, args, settings });
    if (args.includes("Status")) return { status: 0, stdout: '{"installed":true,"running":true}' };
    return { status: 0, stdout: "state = running", stderr: "" };
  } };
  try {
    installService(config, options);
    assert.equal(installedServiceConfig(home), config);
    if (platform === "win32") {
      const launcher = fs.readFileSync(servicePaths(home).launcher, "utf8");
      assert.equal(launcher.charCodeAt(0), 0xFEFF, "PowerShell 5.1 requires BOM for Unicode script literals");
      assert.ok(launcher.includes(config.replace(/'/g, "''")));
      assert.equal(calls[0].args.includes("Stop"), true);
      assert.equal(calls[1].args.includes("Install"), true);
      assert.notEqual(taskName(home), taskName(`${home}-other`));
    } else {
      const plist = fs.readFileSync(plistPath(home), "utf8");
      assert.ok(plist.includes(config.replace(/&/g, "&amp;")));
      assert.ok(plist.includes(`<string>${process.execPath}</string>`));
      assert.deepEqual(calls.map((call) => call.args[0]), ["bootout", "bootstrap"]);
      assert.equal(calls[0].args[1], "gui/123");
    }
    for (const call of calls) assert.equal(call.settings.shell, false);
    assert.equal(serviceStatus(options).running, true);
    restartService(config, options);
    stopService(options);
    assert.ok(fs.existsSync(servicePaths(home).manifest));
    uninstallService(options);
    assert.ok(fs.existsSync(config), "uninstall must preserve user configuration");
    assert.equal(installedServiceConfig(home), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-service-failure-"));
try {
  const config = path.join(home, "config.json");
  fs.writeFileSync(config, "{}");
  assert.throws(() => installService(config, { platform: "win32", home, run: () => ({ status: 1, stderr: "synthetic-secret" }) }), (error) => {
    assert.doesNotMatch(error.message, /synthetic-secret/);
    return error.code === "WINDOWS_OPERATION_FAILED";
  });
  assert.equal(fs.existsSync(servicePaths(home).manifest), false);
  assert.throws(() => installService(config, { platform: "linux", home }), /Windows.*macOS/);
} finally { fs.rmSync(home, { recursive: true, force: true }); }

assert.ok(windowsLauncher("C:\\Program Files\\nodejs\\node.exe", "C:\\用户 O'Brien\\config.json", "C:\\logs").includes("'C:\\用户 O''Brien\\config.json'"));
console.log("service tests passed");
