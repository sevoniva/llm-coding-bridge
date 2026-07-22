"use strict";

const { spawnSync } = require("node:child_process");

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

function createCredentialResolver(descriptors, options = {}) {
  const cache = new Map();
  const run = options.spawnSync || spawnSync;
  const env = options.env || process.env;
  const now = options.now || Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!descriptors || typeof descriptors !== "object" || Array.isArray(descriptors)) {
    throw new Error("Credential descriptors must be an object.");
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error("Credential cache TTL must be a non-negative integer.");

  function resolve(reference, request = {}) {
    const descriptor = descriptors[reference];
    if (!descriptor) throw new Error("Unknown credential reference.");
    if (descriptor.source === "client") {
      if (typeof request.clientApiKey !== "string" || !request.clientApiKey) {
        throw new Error("Missing client credential.");
      }
      return request.clientApiKey;
    }

    const cached = cache.get(reference);
    if (cached && ttlMs > 0 && now() - cached.timestamp < ttlMs) return cached.value;

    let value;
    if (descriptor.source === "env") {
      value = env[descriptor.env];
      if (typeof value !== "string" || !value) throw new Error("Credential environment variable is unavailable.");
    } else if (descriptor.source === "command") {
      const result = run(descriptor.command.command, descriptor.command.args, {
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
        shell: false,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      });
      if (result.error || result.status !== 0) throw new Error("Credential command failed.");
      if (Buffer.byteLength(result.stdout || "", "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
        throw new Error("Credential command output exceeded 64 KiB.");
      }
      value = String(result.stdout || "").trim();
      if (!value) throw new Error("Credential command returned no token.");
    } else {
      throw new Error("Unsupported credential source.");
    }

    if (ttlMs > 0) cache.set(reference, { value, timestamp: now() });
    return value;
  }

  function invalidate(reference) {
    cache.delete(reference);
  }

  function availability(reference) {
    const descriptor = descriptors[reference];
    if (!descriptor) return false;
    if (descriptor.source === "env") return typeof env[descriptor.env] === "string" && Boolean(env[descriptor.env]);
    return descriptor.source === "command" || descriptor.source === "client";
  }

  return Object.freeze({ resolve, invalidate, availability });
}

module.exports = { createCredentialResolver };
