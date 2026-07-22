"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline/promises");

const { loadConfig } = require("./config");
const { normalizeConfigDocument } = require("./config-v2");
const { createCredentialStore } = require("./credential-store");
const { atomicReplacePrivate, readFileSnapshot, stamp, writePrivateFile } = require("./file-safety");
const { probeAllModels, probeModel } = require("./doctor");
const { installService, restartService } = require("./service");
const { applyZcodePlan, detectZcodeState, planZcodeChange } = require("./zcode-client");

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL = /[\u0000-\u001F\u007F]/;

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function onlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains an unsupported field.`);
  }
}

function stringValue(value, label) {
  if (typeof value !== "string" || !value.trim() || CONTROL.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function validateCredential(value) {
  if (!plainObject(value)) throw new Error("Setup profile credential must be an object.");
  if (value.source === "env") {
    onlyKeys(value, ["source", "env"], "Setup profile credential");
    if (typeof value.env !== "string" || !ENV_NAME.test(value.env)) throw new Error("Setup profile env credential is invalid.");
    return { source: "env", env: value.env };
  }
  if (value.source === "client") {
    onlyKeys(value, ["source"], "Setup profile credential");
    return { source: "client" };
  }
  if (value.source === "command") {
    onlyKeys(value, ["source", "command"], "Setup profile credential");
    if (!plainObject(value.command)) throw new Error("Setup profile command credential is invalid.");
    onlyKeys(value.command, ["command", "args"], "Setup profile credential command");
    const command = stringValue(value.command.command, "Setup profile credential command");
    if (!Array.isArray(value.command.args) || value.command.args.some((arg) => typeof arg !== "string" || CONTROL.test(arg))) {
      throw new Error("Setup profile credential command arguments are invalid.");
    }
    return { source: "command", command: { command, args: [...value.command.args] } };
  }
  throw new Error("Setup profile credential source is unsupported.");
}

function validateCapabilities(value) {
  if (value === undefined) return undefined;
  if (!plainObject(value)) throw new Error("Setup profile model capabilities must be an object.");
  onlyKeys(value, ["contextWindow", "inputModalities", "reasoning"], "Setup profile model capabilities");
  const output = {};
  if (value.contextWindow !== undefined) {
    if (!Number.isSafeInteger(value.contextWindow) || value.contextWindow <= 0) throw new Error("Setup profile contextWindow is invalid.");
    output.contextWindow = value.contextWindow;
  }
  if (value.inputModalities !== undefined) {
    if (!Array.isArray(value.inputModalities) || value.inputModalities.length === 0) throw new Error("Setup profile inputModalities are invalid.");
    const allowed = new Set(["text", "image", "audio"]);
    if (value.inputModalities.some((item) => typeof item !== "string" || !allowed.has(item))) {
      throw new Error("Setup profile inputModalities are invalid.");
    }
    output.inputModalities = [...new Set(value.inputModalities)];
  }
  if (value.reasoning !== undefined) {
    if (typeof value.reasoning !== "boolean") throw new Error("Setup profile reasoning capability is invalid.");
    output.reasoning = value.reasoning;
  }
  return output;
}

function validateSetupProfile(input) {
  if (!plainObject(input)) throw new Error("Setup profile must be an object.");
  onlyKeys(input, ["provider", "models", "clients", "service", "probe", "server"], "Setup profile");
  if (!plainObject(input.provider)) throw new Error("Setup profile provider must be an object.");
  onlyKeys(input.provider, ["name", "baseUrl"], "Setup profile provider");
  const provider = {
    name: stringValue(input.provider.name, "Setup profile provider name"),
    baseUrl: stringValue(input.provider.baseUrl, "Setup profile provider baseUrl"),
  };
  if (!Array.isArray(input.models) || input.models.length === 0) throw new Error("Setup profile models must be a non-empty array.");
  const aliases = new Set();
  const models = input.models.map((model) => {
    if (!plainObject(model)) throw new Error("Setup profile model must be an object.");
    onlyKeys(model, ["alias", "upstreamModel", "credential", "capabilities", "reliabilityPolicy"], "Setup profile model");
    if (typeof model.alias !== "string" || !SAFE_ID.test(model.alias) || aliases.has(model.alias)) {
      throw new Error("Setup profile model alias must be a unique safe alias.");
    }
    aliases.add(model.alias);
    const reliabilityPolicy = model.reliabilityPolicy === undefined ? "stable" : model.reliabilityPolicy;
    if (reliabilityPolicy !== "stable" && reliabilityPolicy !== "long-thinking") {
      throw new Error("Setup profile reliability policy is unsupported.");
    }
    return {
      alias: model.alias,
      upstreamModel: stringValue(model.upstreamModel, "Setup profile upstream model"),
      credential: validateCredential(model.credential),
      ...(model.capabilities !== undefined ? { capabilities: validateCapabilities(model.capabilities) } : {}),
      reliabilityPolicy,
    };
  });
  const clients = input.clients === undefined ? [] : input.clients;
  if (!Array.isArray(clients) || clients.some((client) => client !== "zcode") || new Set(clients).size !== clients.length) {
    throw new Error("Setup profile client is unsupported.");
  }
  const service = input.service === undefined ? "none" : input.service;
  if (!["none", "install", "restart"].includes(service)) throw new Error("Setup profile service action is unsupported.");
  const probe = input.probe === undefined ? "all" : input.probe;
  if (probe !== "none" && probe !== "all" && (!SAFE_ID.test(probe) || !aliases.has(probe))) {
    throw new Error("Setup profile probe selection is invalid.");
  }
  let server;
  if (input.server !== undefined) {
    if (!plainObject(input.server)) throw new Error("Setup profile server must be an object.");
    onlyKeys(input.server, ["host", "port"], "Setup profile server");
    server = {};
    if (input.server.host !== undefined) server.host = stringValue(input.server.host, "Setup profile server host");
    if (input.server.port !== undefined) {
      if (!Number.isSafeInteger(input.server.port) || input.server.port < 0 || input.server.port > 65535) {
        throw new Error("Setup profile server port is invalid.");
      }
      server.port = input.server.port;
    }
  }
  return {
    provider,
    models,
    clients: [...clients],
    service,
    probe,
    ...(server ? { server } : {}),
  };
}

function loadSetupProfile(file) {
  const resolved = path.resolve(file);
  const metadata = fs.statSync(resolved);
  if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error("Setup profile must be a regular JSON file under 1 MiB.");
  let document;
  try {
    document = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    throw new Error("Setup profile must contain valid JSON.");
  }
  return validateSetupProfile(document);
}

function safeSlug(value) {
  const slug = String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "").slice(0, 48);
  return slug || "provider";
}

function providerId(profile) {
  const suffix = crypto.createHash("sha256").update(profile.provider.baseUrl).digest("hex").slice(0, 8);
  return `setup-${safeSlug(profile.provider.name)}-${suffix}`;
}

function randomLocalToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function setupDocument(profile, existing, tokenFactory) {
  if (existing && existing.version !== 2) throw new Error("Run config migrate before setup updates a version 1 config.");
  const id = providerId(profile);
  const current = existing || {};
  const oldProvider = Array.isArray(current.providers) ? current.providers.find((provider) => provider?.id === id) : null;
  const otherProviders = Array.isArray(current.providers) ? current.providers.filter((provider) => provider?.id !== id) : [];
  const credentials = plainObject(current.credentials) ? cloneData(current.credentials) : {};
  const usedByOthers = new Set(otherProviders.flatMap((provider) => (
    Array.isArray(provider?.models) ? provider.models.map((model) => model?.credentialRef).filter(Boolean) : []
  )));
  for (const model of oldProvider?.models || []) {
    if (model?.credentialRef && !usedByOthers.has(model.credentialRef)) delete credentials[model.credentialRef];
  }
  const models = profile.models.map((model) => {
    const credentialRef = `${id}-${model.alias}`;
    credentials[credentialRef] = cloneData(model.credential);
    return {
      alias: model.alias,
      upstreamModel: model.upstreamModel,
      credentialRef,
      reliabilityPolicy: model.reliabilityPolicy,
      ...(model.capabilities ? { capabilities: cloneData(model.capabilities) } : {}),
    };
  });
  const existingServer = plainObject(current.server) ? current.server : {};
  const localToken = typeof existingServer.localToken === "string" && existingServer.localToken
    ? existingServer.localToken
    : tokenFactory();
  const document = {
    ...current,
    version: 2,
    server: {
      ...existingServer,
      host: profile.server?.host || existingServer.host || "127.0.0.1",
      port: profile.server?.port ?? existingServer.port ?? 37629,
      localToken,
    },
    providers: [
      ...otherProviders,
      { id, name: profile.provider.name, baseUrl: profile.provider.baseUrl, models },
    ],
    credentials,
  };
  return document;
}

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeSetupConfig(file, document, options = {}) {
  const data = `${JSON.stringify(document, null, 2)}\n`;
  const snapshot = options.snapshot || null;
  if (!snapshot) {
    writePrivateFile(file, data, { exclusive: true });
    return { changed: true, backup: null };
  }
  if (snapshot.bytes.equals(Buffer.from(data))) return { changed: false, backup: null };
  const base = `${snapshot.resolvedTarget}.bak-${stamp(options.now)}`;
  let backup = base;
  let index = 2;
  while (fs.existsSync(backup)) backup = `${base}-${index++}`;
  writePrivateFile(backup, snapshot.bytes, { exclusive: true });
  atomicReplacePrivate(snapshot, data);
  return { changed: true, backup };
}

async function runSetup(input, options = {}) {
  const profile = validateSetupProfile(input);
  const home = path.resolve(options.home || os.homedir());
  const configFile = path.resolve(options.configPath || path.join(home, ".llm-coding-bridge", "config.json"));
  let existing = null;
  let sourceSnapshot = null;
  if (fs.existsSync(configFile)) {
    sourceSnapshot = readFileSnapshot(configFile);
    try {
      existing = JSON.parse(sourceSnapshot.bytes.toString("utf8"));
    } catch {
      throw new Error("Existing bridge config is not valid JSON.");
    }
  }
  const document = setupDocument(profile, existing, options.localTokenFactory || randomLocalToken);
  normalizeConfigDocument(document, configFile);
  if (typeof options.beforeConfigWrite === "function") await options.beforeConfigWrite();
  const write = writeSetupConfig(configFile, document, { ...options, snapshot: sourceSnapshot });
  const config = loadConfig(configFile);

  let zcode = null;
  if (profile.clients.includes("zcode")) {
    const detected = detectZcodeState({ home, ...(options.zcodeVersion ? { version: options.zcodeVersion } : {}) });
    const plan = planZcodeChange({ action: "add", config, home, state: detected });
    if (plan.previewOnly) throw new Error(`ZCode setup is preview-only: ${plan.warnings.join(" ")}`);
    zcode = applyZcodePlan(plan, options);
  }

  if (profile.service === "install") (options.installService || installService)(configFile);
  if (profile.service === "restart") (options.restartService || restartService)(configFile);

  let probes = [];
  if (profile.probe === "all") probes = await (options.probeAllModels || probeAllModels)(config);
  else if (profile.probe !== "none") probes = [await (options.probeModel || probeModel)(config, profile.probe)];
  if (probes.some((result) => !result.ok)) throw new Error("One or more setup model probes failed.");

  return Object.freeze({
    configFile,
    configChanged: write.changed,
    configBackup: write.backup,
    zcode,
    probes,
    aliases: Object.freeze(config.routes.map((route) => route.alias)),
  });
}

async function askLine(question, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const rl = readline.createInterface({ input, output });
  try {
    return String(await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function yes(value) {
  return /^(y|yes|是|好)$/i.test(String(value || "").trim());
}

async function collectSetupProfile(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!input.isTTY) throw new Error("Interactive setup requires a terminal or --profile.");
  const ask = (question) => askLine(question, { input, output });
  const credentialStore = options.credentialStore || createCredentialStore();
  const name = (await ask("Provider name / Provider 名称 [Custom Provider]: ")) || "Custom Provider";
  const baseUrl = await ask("Provider base URL / Provider Base URL: ");
  const models = [];
  for (;;) {
    const alias = await ask("Client model alias / 客户端模型别名: ");
    const upstreamModel = await ask("Exact upstream model ID / 上游模型 ID: ");
    let credential;
    const credentialMode = options.advanced
      ? (await ask("Credential mode (stored/client) [stored]: ")) || "stored"
      : "stored";
    if (credentialMode === "client") {
      credential = { source: "client" };
    } else if (credentialMode !== "stored") {
      throw new Error("Credential mode must be stored or client.");
    } else if (process.platform === "darwin") {
      await storeInteractiveSecret(credentialStore, alias, { input, output });
      credential = credentialStore.descriptor(alias);
    } else {
      credential = credentialStore.descriptor(alias);
      output.write(`Set ${credential.env} before starting the bridge.\n`);
    }
    const model = { alias, upstreamModel, credential };
    if (options.advanced) {
      const context = await ask("Context window / 上下文窗口 [128000]: ");
      const reasoning = await ask("Reasoning model? / 推理模型？[y/N]: ");
      model.capabilities = { contextWindow: Number(context || 128000), inputModalities: ["text"], reasoning: yes(reasoning) };
      model.reliabilityPolicy = (await ask("Reliability policy (stable/long-thinking) [stable]: ")) || "stable";
    }
    models.push(model);
    if (!yes(await ask("Add another model? / 继续添加模型？[y/N]: "))) break;
  }
  const clients = yes(await ask("Configure ZCode? / 配置 ZCode？[y/N]: ")) ? ["zcode"] : [];
  const service = (await ask("Service action (none/install/restart) [none]: ")) || "none";
  const probe = (await ask("Probe scope (none/all/or alias) [all]: ")) || "all";
  return validateSetupProfile({ provider: { name, baseUrl }, models, clients, service, probe });
}

async function runGuidedSetup(options = {}) {
  const profile = await collectSetupProfile(options);
  return runSetup(profile, options);
}

function readSecret(prompt, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Secret input requires an interactive terminal."));
  }

  return new Promise((resolve, reject) => {
    const bytes = [];
    const previousRawMode = input.isRaw === true;
    let settled = false;

    function restore() {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      input.removeListener("end", onEnd);
      try { input.setRawMode(previousRawMode); } catch {}
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      restore();
      output.write("\n");
      if (error) reject(error);
      else resolve(Buffer.from(bytes));
      bytes.fill(0);
    }

    function onError() {
      finish(new Error("Secret input failed."));
    }

    function onEnd() {
      finish(new Error("Secret input ended before a value was provided."));
    }

    function onData(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of data) {
        if (byte === 3) {
          finish(new Error("Secret input was cancelled."));
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          if (bytes.length > 0) {
            bytes.pop();
            output.write("\b \b");
          }
          continue;
        }
        if (byte < 32) continue;
        bytes.push(byte);
        output.write(".");
      }
    }

    output.write(prompt);
    input.setRawMode(true);
    input.on("data", onData);
    input.once("error", onError);
    input.once("end", onEnd);
    input.resume();
  });
}

async function storeInteractiveSecret(store, alias, options = {}) {
  const reader = options.reader || (() => readSecret(`API key for ${alias}: `, options));
  const secret = await reader();
  if (!Buffer.isBuffer(secret)) throw new TypeError("Secret reader must return a Buffer.");
  try {
    return await store.save(alias, secret);
  } finally {
    secret.fill(0);
  }
}

module.exports = {
  collectSetupProfile,
  loadSetupProfile,
  readSecret,
  runGuidedSetup,
  runSetup,
  storeInteractiveSecret,
  validateSetupProfile,
};
