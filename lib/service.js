"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { writePrivateFile } = require("./file-safety");
const { runWindows } = require("./windows");

function serviceLabel() { return "com.sevoniva.llm-coding-bridge"; }
function plistPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${serviceLabel()}.plist`);
}
function servicePaths(home = os.homedir()) {
  const root = path.join(path.resolve(home), ".llm-coding-bridge");
  return { root, logs: path.join(root, "logs"), manifest: path.join(root, "service.json"), launcher: path.join(root, "service", "start.ps1") };
}
function taskName(home = os.homedir()) {
  const suffix = crypto.createHash("sha256").update(path.resolve(home).toLowerCase()).digest("hex").slice(0, 12);
  return `LLM Coding Bridge-${suffix}`;
}
function installedServiceConfig(home) {
  const file = servicePaths(home).manifest;
  if (!fs.existsSync(file)) return null;
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof manifest.configPath !== "string" || !path.isAbsolute(manifest.configPath)) throw new Error("Service configuration path is invalid.");
  return manifest.configPath;
}
function serviceOptions(options = {}) {
  const platform = options.platform || process.platform;
  if (!["darwin", "win32"].includes(platform)) {
    const error = new Error("Autostart supports Windows Task Scheduler and macOS launchd. On Linux, run serve under your service manager.");
    error.code = "SERVICE_UNSUPPORTED";
    throw error;
  }
  return { ...options, platform, home: path.resolve(options.home || os.homedir()), run: options.run || spawnSync };
}
function runLaunchctl(args, options, checked = true) {
  const result = options.run("launchctl", args, { encoding: "utf8", shell: false, timeout: 15000 });
  if (checked && (result.error || result.status !== 0)) {
    const error = new Error("launchd operation failed. Run service-status and logs to inspect the service.");
    error.code = "SERVICE_OPERATION_FAILED";
    throw error;
  }
  return result;
}
function domain(options) { return `gui/${options.uid ?? process.getuid()}`; }
function xml(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function psLiteral(value) { return `'${String(value).replace(/'/g, "''")}'`; }

function windowsLauncher(node, config, logs) {
  const runner = path.join(__dirname, "..", "scripts", "service-runner.js");
  return `\uFEFF$ErrorActionPreference = 'Stop'\r\n& ${[node, runner, config, logs].map(psLiteral).join(" ")}\r\nexit $LASTEXITCODE\r\n`;
}

function installService(configPath, options = {}) {
  const settings = serviceOptions(options);
  const { home, platform } = settings;
  const config = path.resolve(configPath);
  if (!fs.statSync(config).isFile()) throw new Error("Service config must be a regular file.");
  const paths = servicePaths(home);
  fs.mkdirSync(paths.logs, { recursive: true, mode: 0o700 });
  const node = settings.nodePath || process.execPath;
  if (platform === "win32") {
    runWindows("windows-service.ps1", ["-Action", "Stop", "-Name", taskName(home)], { run: settings.run });
    writePrivateFile(paths.launcher, windowsLauncher(node, config, paths.logs));
    runWindows("windows-service.ps1", ["-Action", "Install", "-Name", taskName(home), "-Launcher", paths.launcher], { run: settings.run });
  } else {
    const argumentsXml = [node, path.join(__dirname, "..", "bin", "llm-coding-bridge.js"), "serve", "--config", config].map((arg) => `<string>${xml(arg)}</string>`).join("");
    const executablePath = [...new Set([path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${serviceLabel()}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(executablePath)}</string></dict>
<key>ProgramArguments</key><array>${argumentsXml}</array>
<key>WorkingDirectory</key><string>${xml(home)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(path.join(paths.logs, "out.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(paths.logs, "err.log"))}</string>
</dict></plist>\n`;
    writePrivateFile(plistPath(home), plist);
    runLaunchctl(["bootout", domain(settings), plistPath(home)], settings, false);
    runLaunchctl(["bootstrap", domain(settings), plistPath(home)], settings);
  }
  writePrivateFile(paths.manifest, `${JSON.stringify({ platform, configPath: config, nodePath: node }, null, 2)}\n`);
  console.log(`[OK] Autostart installed; starts after login / 已安装登录自启动: ${platform === "win32" ? taskName(home) : plistPath(home)}`);
  console.log(`[OK] service config: ${config}\nCheck: llm-coding-bridge status`);
  return { configPath: config, ...paths };
}
function restartService(configPath, options = {}) { return installService(configPath, options); }
function stopService(options = {}) {
  const settings = serviceOptions(options);
  if (settings.platform === "win32") {
    runWindows("windows-service.ps1", ["-Action", "Stop", "-Name", taskName(settings.home)], { run: settings.run });
  } else {
    const current = runLaunchctl(["print", `${domain(settings)}/${serviceLabel()}`], settings, false);
    if (current.status === 0) runLaunchctl(["bootout", domain(settings), plistPath(settings.home)], settings);
  }
  console.log("[OK] service stopped; autostart retained / 已停止，下次登录仍会自启动。");
}
function uninstallService(options = {}) {
  const settings = serviceOptions(options);
  if (settings.platform === "win32") {
    runWindows("windows-service.ps1", ["-Action", "Uninstall", "-Name", taskName(settings.home)], { run: settings.run });
    fs.rmSync(servicePaths(settings.home).launcher, { force: true });
  } else {
    stopService(settings);
    fs.rmSync(plistPath(settings.home), { force: true });
  }
  fs.rmSync(servicePaths(settings.home).manifest, { force: true });
  console.log("[OK] autostart removed; config and credentials kept / 已取消自启动，保留配置和密钥。");
}
function serviceStatus(options = {}) {
  const settings = serviceOptions(options);
  const paths = servicePaths(settings.home);
  let result;
  if (settings.platform === "win32") {
    result = JSON.parse(runWindows("windows-service.ps1", ["-Action", "Status", "-Name", taskName(settings.home)], { run: settings.run }));
  } else {
    const query = runLaunchctl(["print", `${domain(settings)}/${serviceLabel()}`], settings, false);
    result = { installed: fs.existsSync(plistPath(settings.home)), running: query.status === 0 && /state = running/.test(query.stdout || "") };
  }
  return { ...result, platform: settings.platform, configPath: installedServiceConfig(settings.home), logs: paths.logs };
}

module.exports = { serviceLabel, plistPath, servicePaths, taskName, windowsLauncher, installedServiceConfig, installService, restartService, stopService, uninstallService, serviceStatus };
