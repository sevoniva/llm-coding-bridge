#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");

const { loadConfig, isLoopbackHost } = require("../lib/config");
const { startServer } = require("../lib/server");
const { doctor, status } = require("../lib/doctor");
const { createCodexProfile } = require("../lib/codex-profile");
const { configureClaudeCode, configureCodexDesktop, manualClaude, manualCodexCli, manualCodexDesktop, manualSetup } = require("../lib/client-setup");
const { writePrivateFile } = require("../lib/file-safety");
const { installService, restartService, uninstallService } = require("../lib/service");

const CWD_CONFIG = "llm-coding-bridge.config.json";

function homeConfigPath(home) {
  return path.join(home, ".llm-coding-bridge", "config.json");
}

function defaultConfigPath(home) {
  return fs.existsSync(CWD_CONFIG) ? path.resolve(CWD_CONFIG) : homeConfigPath(home);
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "help";
  const args = { command, config: "", out: "", name: "llm-coding-bridge", home: os.homedir(), lines: 80 };
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
  if (!args.config) args.config = defaultConfigPath(args.home);
  if (!args.out) args.out = homeConfigPath(args.home);
  return args;
}

function usage() {
  return `Usage:
  llm-coding-bridge init [--out <file>]
  llm-coding-bridge serve [--config <file>]
  llm-coding-bridge doctor [--deep] [--tools] [--config <file>]
  llm-coding-bridge status [--config <file>]
  llm-coding-bridge codex-profile --name bridge [--force] [--config <file>]
  llm-coding-bridge template codex
  llm-coding-bridge template codex-desktop
  llm-coding-bridge template claude
  llm-coding-bridge template zcode
  llm-coding-bridge logs --lines 80
  llm-coding-bridge install-service [--config <file>]
  llm-coding-bridge restart-service [--config <file>]
  llm-coding-bridge uninstall-service

Without --config, commands use ./${CWD_CONFIG} if present,
otherwise ~/.llm-coding-bridge/config.json. init writes there by default.`;
}

function publicErrorMessage(error) {
  const message = String(error && error.message ? error.message : "");
  switch (message) {
    case "Missing upstream or upstreams.":
      return "Missing upstream or upstreams.";
    case "Missing upstream.baseUrl.":
      return "Missing upstream.baseUrl.";
    case "Missing upstream.model.":
      return "Missing upstream.model.";
    case "upstream.apiKeySource must be \"client\" when set.":
      return "upstream.apiKeySource must be \"client\" when set.";
    case "server.localToken is required when server.host is not a loopback address.":
      return "server.localToken is required when server.host is not a loopback address.";
    case "Missing upstream.apiKeyEnv, upstream.apiKeyCommand, or upstream.apiKeySource.":
      return "Missing upstream.apiKeyEnv, upstream.apiKeyCommand, or upstream.apiKeySource.";
    case "Missing client API key.":
      return "Missing client API key.";
    case "apiKeyCommand returned an empty token.":
      return "apiKeyCommand returned an empty token.";
    case "Set LLM_CODING_BRIDGE_CLIENT_API_KEY to run doctor with apiKeySource=client.":
      return "Set LLM_CODING_BRIDGE_CLIENT_API_KEY to run doctor with apiKeySource=client.";
    default:
      break;
  }
  if (message.startsWith("Unknown argument:")) return "Unknown argument.";
  if (message.startsWith("Unknown command:")) return "Unknown command.";
  if (message.startsWith("Config file not found:")) return "Config file not found. Run \"llm-coding-bridge init\" to create one.";
  if (message.startsWith("Config file is not valid JSON:")) return "Config file is not valid JSON.";
  if (message.startsWith("apiKeyCommand exited with")) return "apiKeyCommand exited with a non-zero status.";
  if (/^upstream\.(timeoutMs|maxResponseBytes|maxSseEventBytes) must be a positive integer\.$/.test(message)) return message;
  if (message.includes("already exists")) return "Target file already exists. Re-run with --force to overwrite.";
  if (message.endsWith(" is required.")) return "A required value is missing.";
  if (message.includes(" must be a number")) return "A numeric value is invalid.";
  return "Command failed.";
}

function valueOrDefault(value, fallback) {
  const trimmed = String(value || "").trim();
  return trimmed || fallback;
}

async function askRequired(prompt, question, label) {
  for (;;) {
    const value = String(await prompt.ask(question)).trim();
    if (value) return value;
    if (!prompt.interactive) throw new Error(`${label} is required.`);
    console.log(`${label} is required. / ${label} 不能为空。`);
  }
}

async function askNumber(prompt, question, fallback, label) {
  for (;;) {
    const raw = valueOrDefault(await prompt.ask(question), fallback);
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
    if (!prompt.interactive) throw new Error(`${label} must be a number: ${raw}`);
    console.log(`${label} must be a number. / ${label} 必须是数字。`);
  }
}

async function askChoice(prompt, question, choices, fallback, label) {
  for (;;) {
    const value = valueOrDefault(await prompt.ask(question), fallback).toLowerCase();
    if (choices.includes(value)) return value;
    if (!prompt.interactive) throw new Error(`${label} must be one of: ${choices.join(", ")}`);
    console.log(`${label} must be one of: ${choices.join(", ")}. / ${label} 只能是：${choices.join("、")}。`);
  }
}

function isYes(value) {
  return /^(y|yes|是|好)$/i.test(String(value || "").trim());
}

async function confirm(prompt, question) {
  return isYes(await prompt.ask(question));
}

function printWriteResult(label, result) {
  console.log(`[OK] ${label}: ${result.file}`);
  for (const backup of [result.backup, result.catalogBackup].filter(Boolean)) {
    console.log(`[OK] backup ${backup}`);
  }
}

async function configureClients(prompt, config, home) {
  const wantsClients = await confirm(prompt, "\nConfigure local clients now? / 是否现在配置本地客户端？[y/N]: ");
  if (!wantsClients) {
    console.log(`\n${manualSetup(config)}`);
    return;
  }

  if (await confirm(prompt, "Configure Claude Code settings? This affects Claude Code environment. / 是否配置 Claude Code？会影响 Claude Code 环境。[y/N]: ")) {
    try {
      printWriteResult("Claude Code settings", configureClaudeCode(config, home));
    } catch (error) {
      console.log(`Claude Code setup skipped: ${publicErrorMessage(error)}`);
      console.log(manualClaude(config));
    }
  } else {
    console.log(manualClaude(config));
  }

  if (await confirm(prompt, "Generate isolated Codex CLI profile? This does not affect Codex Desktop. / 是否生成 Codex CLI 独立 profile？不影响 Codex Desktop。[y/N]: ")) {
    try {
      createCodexProfile(config, "bridge", home, false);
    } catch (error) {
      if (!/already exists/.test(error.message)) {
        console.log(`Codex CLI setup skipped: ${publicErrorMessage(error)}`);
        console.log(manualCodexCli(config));
      } else if (await confirm(prompt, "Existing Codex profile files found. Back up and overwrite? / 已有 Codex profile 文件，是否备份并覆盖？[y/N]: ")) {
        try {
          createCodexProfile(config, "bridge", home, true);
        } catch (overwriteError) {
          console.log(`Codex CLI setup skipped: ${publicErrorMessage(overwriteError)}`);
          console.log(manualCodexCli(config));
        }
      } else {
        console.log(manualCodexCli(config));
      }
    }
  } else {
    console.log(manualCodexCli(config));
  }

  console.log("Codex Desktop setup changes the default Codex Desktop provider.");
  console.log("配置 Codex Desktop 会改变 Codex Desktop 默认 provider。");
  if (await confirm(prompt, "Configure Codex Desktop default provider? / 是否配置 Codex Desktop 默认 provider？[y/N]: ")) {
    if (await confirm(prompt, "Confirm Codex Desktop default change? / 确认修改 Codex Desktop 默认配置？[y/N]: ")) {
      try {
        printWriteResult("Codex Desktop config", configureCodexDesktop(config, home));
      } catch (error) {
        console.log(`Codex Desktop setup skipped: ${publicErrorMessage(error)}`);
        console.log(manualCodexDesktop(config));
      }
    } else {
      console.log(manualCodexDesktop(config));
    }
  } else {
    console.log(manualCodexDesktop(config));
  }
}

async function initConfig(out, runDoctor, home) {
  const prompt = createPrompt();
  try {
    console.log("LLM Coding Bridge setup / LLM Coding Bridge 配置向导");
    console.log("The bridge config does not store upstream API keys. Generated client configs may store a client-managed key with private file permissions.");
    console.log("bridge 配置不保存上游 API Key。自动生成的客户端配置可能保存由客户端管理的 Key，并使用私有文件权限。\n");
    const host = valueOrDefault(await prompt.ask("Listen host / 本地监听地址 [127.0.0.1]: "), "127.0.0.1");
    const port = await askNumber(prompt, "Listen port / 本地监听端口 [37629]: ", "37629", "Listen port");
    const name = valueOrDefault(await prompt.ask("Provider name / 上游服务名称 [Custom Provider]: "), "Custom Provider");
    const baseUrl = await askRequired(prompt, "Upstream base URL / 上游 Base URL: ", "Upstream base URL");
    const model = await askRequired(prompt, "Upstream model / 上游模型名称: ", "Upstream model");
    const keySource = await askChoice(prompt, "API key source (local/client) / API Key 来源（local/client）[local]: ", ["local", "client"], "local", "API key source");
    const apiKeyEnv = keySource === "local" ? valueOrDefault(await prompt.ask("API key environment variable / API Key 环境变量 [LLM_API_KEY]: "), "LLM_API_KEY") : "";
    const apiKeyCommand = keySource === "local" ? valueOrDefault(await prompt.ask("API key command (optional) / API Key 读取命令（可选）: "), "") : "";
    const temperature = await askNumber(prompt, "Temperature / 采样温度 [0]: ", "0", "Temperature");
    const localToken = valueOrDefault(await prompt.ask("Local auth token (required for non-loopback hosts) / 本地鉴权 token（非 loopback 必填）: "), "");
    if (!isLoopbackHost(host) && !localToken) {
      throw new Error("server.localToken is required when server.host is not a loopback address.");
    }

    const config = {
      server: { host, port, ...(localToken ? { localToken } : {}) },
      upstream: { name, baseUrl, model, temperature },
    };
    if (keySource === "client") config.upstream.apiKeySource = "client";
    else config.upstream.apiKeyEnv = apiKeyEnv;
    if (apiKeyCommand) config.upstream.apiKeyCommand = apiKeyCommand;

    const file = path.resolve(out);
    writePrivateFile(file, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`\nWrote config: ${file}`);
    console.log(`配置已写入：${file}`);
    if (keySource === "client") {
      console.log("Client requests must include the upstream API key.");
      console.log("客户端请求必须携带上游 API Key。");
    } else {
      console.log("Set the configured environment variable before starting.");
      console.log("启动前设置配置中的环境变量。");
    }
    const loaded = loadConfig(file);
    if (runDoctor !== false) await doctor(loaded);
    await configureClients(prompt, loaded, home);
  } finally {
    prompt.close();
  }
}

function createPrompt() {
  if (!process.stdin.isTTY) {
    const lines = fs.readFileSync(0, "utf8").split(/\r?\n/);
    return {
      interactive: false,
      ask(question) {
        process.stdout.write(question);
        return Promise.resolve(lines.shift() || "");
      },
      close() {},
    };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    interactive: true,
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
  if (name === "zcode" || name === "z-code") file = "zcode.env";
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
  if (args.command === "init") return initConfig(args.out, args.doctor, args.home);
  if (args.command === "doctor") return doctor(loadConfig(args.config), args.deep, args.tools);
  if (args.command === "status") return status(loadConfig(args.config));
  if (args.command === "codex-profile") return createCodexProfile(loadConfig(args.config), args.name, args.home, args.force);
  if (args.command === "logs") return printLogs(args.home, args.lines);
  if (args.command === "serve") return startServer(loadConfig(args.config));
  if (args.command === "install-service") return installService(loadConfig(args.config).path);
  if (args.command === "restart-service") return restartService(loadConfig(args.config).path);
  if (args.command === "uninstall-service") return uninstallService();
  throw new Error(`Unknown command: ${args.command}`);
}

main().catch((error) => {
  const message = publicErrorMessage(error);
  console.error(`Error: ${message}`);
  if (/^Unknown (argument|command)\.$/.test(message)) console.error(`\n${usage()}`);
  process.exitCode = 1;
});
