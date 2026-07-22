"use strict";

const COMMANDS = new Set([
  "setup",
  "config",
  "client",
  "init",
  "serve",
  "doctor",
  "status",
  "codex-profile",
  "template",
  "logs",
  "install-service",
  "restart-service",
  "uninstall-service",
  "help",
]);

const CONFIG_ACTIONS = new Set(["show", "migrate"]);
const CLIENT_ACTIONS = new Set(["add", "remove", "rollback"]);
const TEMPLATES = new Set(["codex", "codex-desktop", "claude", "claude-code", "zcode", "z-code"]);

const OPTION_DEFINITIONS = Object.freeze({
  "--config": { key: "config", value: true },
  "-c": { key: "config", value: true, canonical: "--config" },
  "--out": { key: "out", value: true },
  "-o": { key: "out", value: true, canonical: "--out" },
  "--name": { key: "name", value: true },
  "--home": { key: "home", value: true },
  "--lines": { key: "lines", value: true, integer: true },
  "--profile": { key: "profile", value: true },
  "--backup": { key: "backup", value: true },
  "--model": { key: "model", value: true },
  "--force": { key: "force" },
  "--deep": { key: "deep" },
  "--tools": { key: "tools" },
  "--no-doctor": { key: "doctor", booleanValue: false },
  "--advanced": { key: "advanced" },
  "--effective": { key: "effective" },
  "--dry-run": { key: "dryRun" },
  "--all-models": { key: "allModels" },
  "--yes": { key: "yes" },
  "--restart-zcode": { key: "restartZcode" },
  "--help": { key: "help" },
  "-h": { key: "help", canonical: "--help" },
});

const COMMON_CONFIG = ["--config", "--home", "--help"];
const ALLOWED_OPTIONS = Object.freeze({
  setup: ["--profile", "--advanced", "--home", "--yes", "--help"],
  "config:show": ["--effective", ...COMMON_CONFIG],
  "config:migrate": ["--dry-run", "--yes", ...COMMON_CONFIG],
  "client:add": ["--dry-run", "--yes", "--restart-zcode", ...COMMON_CONFIG],
  "client:remove": ["--dry-run", "--yes", "--restart-zcode", ...COMMON_CONFIG],
  "client:rollback": ["--backup", "--dry-run", "--yes", "--restart-zcode", ...COMMON_CONFIG],
  init: ["--out", "--home", "--no-doctor", "--help"],
  serve: COMMON_CONFIG,
  doctor: ["--model", "--all-models", "--deep", "--tools", ...COMMON_CONFIG],
  status: COMMON_CONFIG,
  "codex-profile": ["--name", "--force", ...COMMON_CONFIG],
  template: ["--help"],
  logs: ["--lines", "--home", "--help"],
  "install-service": COMMON_CONFIG,
  "restart-service": COMMON_CONFIG,
  "uninstall-service": ["--help"],
  help: [],
});

function takeRequiredPositional(argv, label) {
  const value = argv.shift();
  if (!value || value.startsWith("-")) throw new Error(`${label} is required.`);
  return value;
}

function commandShape(argv) {
  if (argv.length === 0) return { command: "help", optionKey: "help" };
  if ((argv[0] === "--help" || argv[0] === "-h") && argv.length === 1) {
    argv.shift();
    return { command: "help", optionKey: "help" };
  }

  const command = argv.shift();
  if (!COMMANDS.has(command)) throw new Error(`Unknown command: ${command}`);
  const result = { command };
  let optionKey = command;

  if (command === "config") {
    const action = takeRequiredPositional(argv, "Config action");
    if (!CONFIG_ACTIONS.has(action)) throw new Error(`Unknown config action: ${action}`);
    result.action = action;
    optionKey = `config:${action}`;
  } else if (command === "client") {
    const action = takeRequiredPositional(argv, "Client action");
    if (!CLIENT_ACTIONS.has(action)) throw new Error(`Unknown client action: ${action}`);
    const client = takeRequiredPositional(argv, "Client");
    if (client !== "zcode") throw new Error(`Unknown client: ${client}`);
    result.action = action;
    result.client = client;
    optionKey = `client:${action}`;
  } else if (command === "template") {
    const template = takeRequiredPositional(argv, "Template");
    if (!TEMPLATES.has(template)) throw new Error(`Unknown template: ${template}`);
    result.template = template;
  }

  return { result, optionKey };
}

function parseOptions(argv, result, optionKey) {
  const allowed = new Set(ALLOWED_OPTIONS[optionKey]);
  const seen = new Set();
  while (argv.length > 0) {
    const option = argv.shift();
    if (!option.startsWith("-")) throw new Error(`Unexpected positional argument: ${option}`);
    const definition = OPTION_DEFINITIONS[option];
    const canonical = definition?.canonical || option;
    if (!definition || !allowed.has(canonical)) throw new Error(`Unknown option: ${option}`);
    if (seen.has(canonical)) throw new Error(`Duplicate option: ${canonical}`);
    seen.add(canonical);

    if (!definition.value) {
      result[definition.key] = Object.hasOwn(definition, "booleanValue") ? definition.booleanValue : true;
      continue;
    }

    const value = argv.shift();
    if (!value || value.startsWith("-")) throw new Error(`${canonical} requires a value.`);
    if (definition.integer) {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${canonical} must be a positive integer.`);
      result[definition.key] = number;
    } else {
      result[definition.key] = value;
    }
  }
}

function validateCombinations(result) {
  if (result.command === "config" && result.action === "show" && !result.effective && !result.help) {
    throw new Error("config show requires --effective.");
  }
  if (result.command === "doctor" && result.model && result.allModels) {
    throw new Error("--model and --all-models cannot be used together.");
  }
  if (result.command === "client" && result.action === "rollback" && !result.backup && !result.help) {
    throw new Error("client rollback requires --backup.");
  }
}

function parseCliArgs(input) {
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
    throw new TypeError("CLI arguments must be an array of strings.");
  }
  const argv = [...input];
  const shape = commandShape(argv);
  const result = shape.result || { command: shape.command };
  parseOptions(argv, result, shape.optionKey);
  validateCombinations(result);
  return Object.freeze(result);
}

module.exports = { parseCliArgs };
