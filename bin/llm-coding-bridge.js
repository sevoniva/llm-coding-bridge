#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");

const { loadConfig } = require("../lib/config");
const { startServer } = require("../lib/server");
const { doctor, status } = require("../lib/doctor");
const { createCodexProfile } = require("../lib/codex-profile");
const { installService, restartService, uninstallService } = require("../lib/service");

const DEFAULT_CONFIG = "llm-coding-bridge.config.json";

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "help";
  const args = { command, config: DEFAULT_CONFIG, out: DEFAULT_CONFIG, name: "llm-coding-bridge", home: os.homedir(), lines: 80 };
  if (command === "template" && argv[0] && !argv[0].startsWith("-")) args.template = argv.shift();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-c") args.config = argv[++i];
    else if (arg === "--out" || arg === "-o") args.out = argv[++i];
    else if (arg === "--name") args.name = argv[++i];
    else if (arg === "--home") args.home = argv[++i];
    else if (arg === "--lines") args.lines = Number(argv[++i]);
    else if (arg === "--force") args.force = true;
    else if (arg === "--deep") args.deep = true;
    else if (arg === "--tools") args.tools = true;
    else if (arg === "--no-doctor") args.doctor = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage:
  llm-coding-bridge init --out llm-coding-bridge.config.json
  llm-coding-bridge serve --config llm-coding-bridge.config.json
  llm-coding-bridge doctor --config llm-coding-bridge.config.json
  llm-coding-bridge doctor --deep --config llm-coding-bridge.config.json
  llm-coding-bridge doctor --tools --config llm-coding-bridge.config.json
  llm-coding-bridge status --config llm-coding-bridge.config.json
  llm-coding-bridge codex-profile --config llm-coding-bridge.config.json --name bridge
  llm-coding-bridge template codex
  llm-coding-bridge template codex-desktop
  llm-coding-bridge template claude
  llm-coding-bridge logs --lines 80
  llm-coding-bridge install-service --config ~/.llm-coding-bridge/config.json
  llm-coding-bridge restart-service --config ~/.llm-coding-bridge/config.json
  llm-coding-bridge uninstall-service`;
}

function valueOrDefault(value, fallback) {
  const trimmed = String(value || "").trim();
  return trimmed || fallback;
}

async function initConfig(out, runDoctor) {
  const prompt = createPrompt();
  try {
    console.log("LLM Coding Bridge setup / LLM Coding Bridge 配置向导");
    console.log("API keys are read from environment variables or commands and are not written to config files.");
    console.log("API Key 通过环境变量或命令读取，不写入配置文件。\n");
    const host = valueOrDefault(await prompt.ask("Listen host / 本地监听地址 [127.0.0.1]: "), "127.0.0.1");
    const port = Number(valueOrDefault(await prompt.ask("Listen port / 本地监听端口 [18080]: "), "18080"));
    const name = valueOrDefault(await prompt.ask("Provider name / 上游服务名称 [Custom Provider]: "), "Custom Provider");
    const baseUrl = valueOrDefault(await prompt.ask("Upstream base URL / 上游 Base URL: "), "");
    const model = valueOrDefault(await prompt.ask("Upstream model / 上游模型名称: "), "");
    const apiKeyEnv = valueOrDefault(await prompt.ask("API key environment variable / API Key 环境变量 [LLM_API_KEY]: "), "LLM_API_KEY");
    const apiKeyCommand = valueOrDefault(await prompt.ask("API key command (optional) / API Key 读取命令（可选）: "), "");
    const temperature = Number(valueOrDefault(await prompt.ask("Temperature / 采样温度 [0]: "), "0"));
    const localToken = valueOrDefault(await prompt.ask("Local auth token (optional, blank to disable) / 本地鉴权 token（可选，留空不启用）: "), "");
    if (!baseUrl) throw new Error("Upstream base URL is required.");
    if (!model) throw new Error("Upstream model is required.");
    if (!Number.isFinite(port)) throw new Error("Port must be a number.");
    if (!Number.isFinite(temperature)) throw new Error("Temperature must be a number.");

    const config = {
      server: { host, port, ...(localToken ? { localToken } : {}) },
      upstream: { name, baseUrl, model, apiKeyEnv, temperature },
    };
    if (apiKeyCommand) config.upstream.apiKeyCommand = apiKeyCommand;

    const file = path.resolve(out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`\nWrote config: ${file}`);
    console.log(`配置已写入：${file}`);
    console.log("Set the configured environment variable before starting.");
    console.log("启动前设置配置中的环境变量。");
    if (runDoctor !== false) await doctor(loadConfig(file));
  } finally {
    prompt.close();
  }
}

function createPrompt() {
  if (!process.stdin.isTTY) {
    const lines = fs.readFileSync(0, "utf8").split(/\r?\n/);
    return {
      ask(question) {
        process.stdout.write(question);
        return Promise.resolve(lines.shift() || "");
      },
      close() {},
    };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask(question) {
      return rl.question(question);
    },
    close() {
      rl.close();
    },
  };
}

function printTemplate(name) {
  let file = "codex.config.toml";
  if (name === "claude" || name === "claude-code") file = "claude-code.env";
  if (name === "codex-desktop") file = "codex-desktop.config.toml";
  process.stdout.write(fs.readFileSync(path.join(__dirname, "..", "templates", file), "utf8"));
}

function printLogs(home, lines) {
  const count = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 80;
  const dir = path.join(path.resolve(home), ".llm-coding-bridge", "logs");
  for (const name of ["out.log", "err.log"]) {
    const file = path.join(dir, name);
    console.log(`==> ${file} <==`);
    if (!fs.existsSync(file)) {
      console.log("(missing)");
      continue;
    }
    const text = fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/).slice(-count).join("\n");
    if (text) console.log(text);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === "help") {
    console.log(usage());
    return;
  }
  if (args.command === "template") return printTemplate(args.template || "codex");
  if (args.command === "init") return initConfig(args.out, args.doctor);
  if (args.command === "doctor") return doctor(loadConfig(args.config), args.deep, args.tools);
  if (args.command === "status") return status(loadConfig(args.config));
  if (args.command === "codex-profile") return createCodexProfile(loadConfig(args.config), args.name, args.home, args.force);
  if (args.command === "logs") return printLogs(args.home, args.lines);
  if (args.command === "serve") return startServer(loadConfig(args.config));
  if (args.command === "install-service") return installService(args.config);
  if (args.command === "restart-service") return restartService(args.config);
  if (args.command === "uninstall-service") return uninstallService();
  throw new Error(`Unknown command: ${args.command}`);
}

main().catch(() => {
  console.error("Command failed.");
  process.exitCode = 1;
});
