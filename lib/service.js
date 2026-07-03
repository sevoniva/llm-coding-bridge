"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function serviceLabel() {
  return "com.sevoniva.llm-coding-bridge";
}

function plistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", "com.sevoniva.llm-coding-bridge.plist");
}

function plistEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function servicePath() {
  return [...new Set([path.dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
}

function installService(configPath, verb = "installed") {
  if (process.platform !== "darwin") throw new Error("install-service currently supports macOS launchd only.");
  const config = path.resolve(configPath);
  const logDir = path.join(os.homedir(), ".llm-coding-bridge", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${serviceLabel()}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${plistEscape(servicePath())}</string>
  </dict>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/env</string><string>node</string><string>${plistEscape(path.join(__dirname, "..", "bin", "llm-coding-bridge.js"))}</string><string>serve</string><string>--config</string><string>${plistEscape(config)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${plistEscape(path.join(logDir, "out.log"))}</string>
  <key>StandardErrorPath</key><string>${plistEscape(path.join(logDir, "err.log"))}</string>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), plist);
  const domain = `gui/${process.getuid()}`;
  spawnSync("launchctl", ["bootout", domain, plistPath()], { stdio: "ignore" });
  const result = spawnSync("launchctl", ["bootstrap", domain, plistPath()], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "launchctl bootstrap failed");
  console.log(`[OK] ${verb} ${plistPath()}`);
}

function restartService(configPath) {
  installService(configPath, "restarted");
}

function uninstallService() {
  if (process.platform !== "darwin") throw new Error("uninstall-service currently supports macOS launchd only.");
  const domain = `gui/${process.getuid()}`;
  spawnSync("launchctl", ["bootout", domain, plistPath()], { stdio: "ignore" });
  fs.rmSync(plistPath(), { force: true });
  console.log(`[OK] removed ${plistPath()}`);
}

module.exports = { serviceLabel, plistPath, installService, restartService, uninstallService };
