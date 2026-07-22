"use strict";

const { spawnSync } = require("node:child_process");

const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SECURITY = "/usr/bin/security";
const TIMEOUT_MS = 10000;

function validateAlias(alias) {
  if (typeof alias !== "string" || !SAFE_ALIAS.test(alias)) {
    throw new Error("Credential alias must be a safe alias.");
  }
  return alias;
}

function keychainIdentity(alias) {
  validateAlias(alias);
  return {
    service: `@sevoniva/llm-coding-bridge/${alias}`,
    account: `model/${alias}`,
  };
}

function portableVariable(alias) {
  validateAlias(alias);
  const encoded = Buffer.from(alias, "utf8").toString("hex").toUpperCase();
  return `LLM_CODING_BRIDGE_ALIAS_${encoded}_API_KEY`;
}

function keychainDescriptor(alias) {
  const identity = keychainIdentity(alias);
  return Object.freeze({
    source: "command",
    command: Object.freeze({
      command: SECURITY,
      args: Object.freeze([
        "find-generic-password",
        "-s",
        identity.service,
        "-a",
        identity.account,
        "-w",
      ]),
    }),
  });
}

function envDescriptor(alias) {
  return Object.freeze({ source: "env", env: portableVariable(alias) });
}

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function defaultRunner(command, args, options) {
  return spawnSync(command, args, options);
}

function runKeychain(run, args) {
  let result;
  try {
    result = run(SECURITY, args, {
      encoding: null,
      shell: false,
      stdio: "pipe",
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    throw safeError("CREDENTIAL_STORE_COMMAND_FAILED", "Credential store command failed.");
  }
  if (!result || result.error || result.status !== 0) {
    throw safeError("CREDENTIAL_STORE_COMMAND_FAILED", "Credential store command failed.");
  }
  return result;
}

function secretText(secret) {
  const value = Buffer.isBuffer(secret) ? secret.toString("utf8") : String(secret || "");
  if (!value || value.includes("\0")) throw safeError("CREDENTIAL_VALUE_INVALID", "Credential value is invalid.");
  return value;
}

function createCredentialStore(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.run || defaultRunner;
  const env = options.env || process.env;
  const darwin = platform === "darwin";

  function descriptor(alias) {
    return darwin ? keychainDescriptor(alias) : envDescriptor(alias);
  }

  function save(alias, secret) {
    const reference = descriptor(alias);
    if (!darwin) return Object.freeze({ ok: false, code: "ENV_MANAGED_EXTERNALLY", descriptor: reference });
    const identity = keychainIdentity(alias);
    runKeychain(run, [
      "add-generic-password",
      "-U",
      "-s",
      identity.service,
      "-a",
      identity.account,
      "-w",
      secretText(secret),
    ]);
    return Object.freeze({ ok: true, code: "SAVED", descriptor: reference });
  }

  function read(alias) {
    const reference = descriptor(alias);
    if (!darwin) {
      const value = env[reference.env];
      if (typeof value !== "string" || !value) {
        throw safeError("CREDENTIAL_NOT_AVAILABLE", "Credential is not available.");
      }
      return value;
    }
    const result = runKeychain(run, reference.command.args);
    const value = Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8").trim()
      : String(result.stdout || "").trim();
    if (!value) throw safeError("CREDENTIAL_NOT_AVAILABLE", "Credential is not available.");
    return value;
  }

  function remove(alias) {
    descriptor(alias);
    if (!darwin) return Object.freeze({ ok: false, code: "ENV_MANAGED_EXTERNALLY" });
    const identity = keychainIdentity(alias);
    runKeychain(run, [
      "delete-generic-password",
      "-s",
      identity.service,
      "-a",
      identity.account,
    ]);
    return Object.freeze({ ok: true, code: "DELETED" });
  }

  return Object.freeze({ descriptor, save, read, delete: remove });
}

module.exports = { createCredentialStore };
