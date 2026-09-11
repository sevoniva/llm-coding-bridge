"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

function powershellPath() {
  return path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function powershellArgs(script, args = []) {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "..", "scripts", script), ...args];
}

function runWindows(script, args, options = {}) {
  const { run = spawnSync, ...settings } = options;
  const result = run(powershellPath(), powershellArgs(script, args), {
    encoding: "utf8", shell: false, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, ...settings,
  });
  if (!result || result.error || result.status !== 0) {
    const error = new Error("Windows operation failed. Check PowerShell and current-user permissions. / Windows 操作失败，请检查 PowerShell 和当前用户权限。");
    error.code = "WINDOWS_OPERATION_FAILED";
    throw error;
  }
  return String(result.stdout || "").replace(/^\uFEFF/, "").trim();
}

module.exports = { powershellPath, powershellArgs, runWindows };
