"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writePrivateFile } = require("./file-safety");
const { loadConfig, localUrl } = require("./config");
const { restartService } = require("./service");

const ACTIONS = { start: "reload", restart: "reload", stop: "stop-service", status: "status", "disable-autostart": "uninstall-service" };
const shQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const batchQuote = (value) => `"${String(value).replace(/%/g, "%%")}"`;

function scriptText(action, options = {}) {
  const platform = options.platform || process.platform;
  const cli = options.cli || path.join(__dirname, "..", "bin", "llm-coding-bridge.js");
  const node = options.node || process.execPath;
  const home = options.home || os.homedir();
  const withConfig = action === "reload" || action === "status";
  if (platform === "win32") {
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n${batchQuote(node)} ${batchQuote(cli)} ${action}${withConfig ? ' --config "%~dp0config.json"' : ""} --home ${batchQuote(home)}\r\nset "bridgeExit=%errorlevel%"\r\necho.\r\nif not "%bridgeExit%"=="0" echo Operation failed. See the message above, then open config.json and retry.\r\npause\r\nexit /b %bridgeExit%\r\n`;
  }
  return `#!/bin/sh\nSCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\n${shQuote(node)} ${shQuote(cli)} ${action}${withConfig ? ' --config "$SCRIPT_DIR/config.json"' : ""} --home ${shQuote(home)}\nbridge_exit=$?\nprintf '\\nPress Enter to close... '\nread -r answer\nexit "$bridge_exit"\n`;
}

function initLocalFiles(directory, options = {}) {
  const root = path.resolve(directory);
  const configFile = path.join(root, "config.json");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(configFile)) {
    writePrivateFile(configFile, fs.readFileSync(path.join(__dirname, "..", "templates", "simple.config.example.json")), { exclusive: true });
  }
  const platform = options.platform || process.platform;
  const extension = platform === "win32" ? "cmd" : "command";
  const scripts = [];
  for (const [name, action] of Object.entries(ACTIONS)) {
    const file = path.join(root, `${name}.${extension}`);
    writePrivateFile(file, scriptText(action, options));
    if (platform !== "win32") fs.chmodSync(file, 0o700);
    scripts.push(file);
  }
  const instructions = `\uFEFFLLM Coding Bridge 使用说明

1. 打开 config.json，只需填写 upstream.baseUrl（服务商地址）、upstream.model（模型 ID）、upstream.apiKey（真实密钥）。
2. 保存后双击 restart.${extension}，自动加载新配置，并开启登录自启动。
3. 在 ZCode 填：
   Base URL: http://127.0.0.1:37629/v1
   Model: 与 upstream.model 相同
   API Key: local

以后每次修改配置，保存，再双击 restart.${extension} 即可。
stop.${extension}：暂时停止，下次登录仍会启动。
disable-autostart.${extension}：停止并取消自启动。
status.${extension}：检查状态和实际配置位置。

配置文件包含真实密钥，请保留在本机。init-files 会保留已有 config.json。
如果修改了 server.port 或 server.localToken，请在 ZCode 同步对应的端口和令牌。
`;
  writePrivateFile(path.join(root, "HOW-TO-USE.txt"), instructions);
  return { root, configFile, scripts };
}

async function waitForConfig(config, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 20000);
  const fetcher = options.fetch || fetch;
  do {
    try {
      const result = await fetcher(localUrl(config, "/health"), { signal: AbortSignal.timeout(1000) });
      if (result.ok && result.headers.get("x-bridge-config-revision") === config.revision && (await result.json()).ok === true) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 300));
  } while (Date.now() < deadline);
  const error = new Error("Service did not load this config. Run logs --lines 80; check for another process using the port. / 服务未加载这份配置，请检查日志及端口占用。");
  error.code = "SERVICE_OPERATION_FAILED";
  throw error;
}

async function reloadLocalConfig(file, options = {}) {
  const config = loadConfig(file);
  if (config.server.port === 0 || config.routes.some((route) => route.model === "YOUR_MODEL_ID" || route.apiKey === "YOUR_API_KEY" || route.baseUrl === "https://api.example.com/v1")) {
    const error = new Error("Edit config.json first: fill upstream.baseUrl, upstream.model and upstream.apiKey; use a fixed server.port. / 请先填服务地址、模型 ID 和 API Key，再双击重启。");
    error.code = "SERVICE_OPERATION_FAILED";
    throw error;
  }
  (options.restartService || restartService)(config.path, options);
  await waitForConfig(config, options);
  console.log(`[OK] Configuration loaded / 配置已重新加载: ${config.path}`);
  console.log(`\nZCode Base URL: ${localUrl(config, "/v1")}\nZCode Model: ${config.defaultUpstream.alias || config.defaultUpstream.model}`);
  console.log(config.server.localToken ? "ZCode API Key: use server.localToken from config.json" : "ZCode API Key: local");
  return config;
}

module.exports = { initLocalFiles, scriptText, waitForConfig, reloadLocalConfig };
