"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");

const { normalizeConfigDocument } = require("./config-v2");
const { atomicReplacePrivate, readFileSnapshot, stamp, verifyPrivateRegularFile, writePrivateFile } = require("./file-safety");

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function credentialSummary(route) {
  const descriptor = route.credential || {};
  let reference = "request";
  if (descriptor.source === "env") reference = descriptor.env;
  if (descriptor.source === "command") {
    reference = typeof descriptor.command === "object" && descriptor.command
      ? descriptor.command.command
      : "shell-command";
  }
  return {
    ref: route.credentialRef,
    source: descriptor.source,
    reference,
  };
}

function effectiveConfigDocument(config) {
  if (!config || typeof config !== "object" || !Array.isArray(config.routes)) {
    throw new TypeError("A normalized configuration is required.");
  }
  const effectiveByAlias = new Map((config.effective?.routes || []).map((route) => [route.alias, route]));
  return {
    version: config.version,
    configSource: config.path,
    server: {
      host: config.server.host,
      port: config.server.port,
      localTokenConfigured: typeof config.server.localToken === "string" && Boolean(config.server.localToken),
    },
    routes: config.routes.map((route) => {
      const effective = effectiveByAlias.get(route.alias) || {};
      return {
        alias: route.alias,
        provider: {
          id: route.providerId,
          name: route.providerName,
          baseUrl: route.baseUrl,
        },
        upstreamModel: route.upstreamModel,
        credential: credentialSummary(route),
        capabilities: route.capabilities,
        reliabilityPolicy: effective.reliabilityPolicy || "stable",
        reliability: effective.reliability || {},
      };
    }),
  };
}

function safeIdentifier(value, fallback) {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);
  return normalized && SAFE_IDENTIFIER.test(normalized) ? normalized : fallback;
}

function uniqueIdentifier(base, seed, used) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const suffix = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 8);
  let candidate = `${base}-${suffix}`;
  let counter = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix}-${counter++}`;
  used.add(candidate);
  return candidate;
}

function migratedCredential(descriptor) {
  if (descriptor.source === "env") return { source: "env", env: descriptor.env };
  if (descriptor.source === "client") return { source: "client" };
  if (descriptor.source === "command") {
    const command = typeof descriptor.command === "string"
      ? { command: "/bin/sh", args: ["-lc", descriptor.command] }
      : { command: descriptor.command.command, args: [...descriptor.command.args] };
    return { source: "command", command };
  }
  throw new Error("Cannot migrate an unsupported credential source.");
}

function redactedMigrationDocument(document) {
  return {
    ...document,
    server: {
      ...document.server,
      ...(Object.hasOwn(document.server, "localToken")
        ? { localToken: undefined, localTokenConfigured: Boolean(document.server.localToken) }
        : {}),
    },
    credentials: Object.fromEntries(Object.entries(document.credentials).map(([ref, descriptor]) => [
      ref,
      {
        source: descriptor.source,
        reference: descriptor.source === "env"
          ? descriptor.env
          : descriptor.source === "command"
            ? descriptor.command.command
            : "request",
      },
    ])),
  };
}

function migrationPlan(config, snapshot) {
  if (config.version !== 1) throw new Error("Only version 1 configuration can be migrated.");
  if (!snapshot || snapshot.requestedPath !== config.path) throw new Error("Configuration snapshot does not match the loaded file.");
  if (config.defaultUpstream && !config.routes.includes(config.defaultUpstream)) {
    throw new Error("Cannot safely migrate a config that defines both upstream and upstreams.");
  }

  const aliasSet = new Set();
  const providerIds = new Set();
  const credentialRefs = new Set();
  const groups = new Map();
  const effectiveByAlias = new Map((config.effective?.routes || []).map((route) => [route.alias, route]));
  for (const route of config.routes) {
    if (!SAFE_IDENTIFIER.test(route.alias) || aliasSet.has(route.alias)) {
      throw new Error("Version 1 model names must be unique safe aliases before migration.");
    }
    aliasSet.add(route.alias);
    const groupKey = `${route.providerName}\u0000${route.baseUrl}`;
    let group = groups.get(groupKey);
    if (!group) {
      const base = safeIdentifier(route.providerName, "provider");
      const id = uniqueIdentifier(base, groupKey, providerIds);
      group = { id, name: route.providerName, baseUrl: route.baseUrl, models: [] };
      groups.set(groupKey, group);
    }

    const credentialBase = `${group.id}-${safeIdentifier(route.alias, "model")}`.slice(0, 120);
    const credentialRef = uniqueIdentifier(credentialBase, `${groupKey}\u0000${route.alias}`, credentialRefs);
    const effective = effectiveByAlias.get(route.alias) || {};
    const reliability = {
      ...route.reliability,
      nonStreamingTotalTimeoutMs: route.timeoutMs,
      downstreamHeartbeatIntervalMs: route.heartbeatIntervalMs,
    };
    group.models.push({
      alias: route.alias,
      upstreamModel: route.upstreamModel,
      credentialRef,
      reliabilityPolicy: effective.reliabilityPolicy || "stable",
      reliability,
      capabilities: route.capabilities,
      maxResponseBytes: route.maxResponseBytes,
      maxSseEventBytes: route.maxSseEventBytes,
      ...(route.apiKeyCacheTtlMs !== undefined ? { apiKeyCacheTtlMs: route.apiKeyCacheTtlMs } : {}),
    });
    group.credentials ||= {};
    group.credentials[credentialRef] = migratedCredential(route.credential);
  }

  const credentials = {};
  const providers = [];
  for (const group of groups.values()) {
    Object.assign(credentials, group.credentials);
    providers.push({ id: group.id, name: group.name, baseUrl: group.baseUrl, models: group.models });
  }
  const document = {
    version: 2,
    server: { ...config.server },
    providers,
    credentials,
  };
  normalizeConfigDocument(document, snapshot.requestedPath);
  return Object.freeze({
    snapshot,
    document,
    preview: redactedMigrationDocument(document),
  });
}

function applyMigrationPlan(plan, options = {}) {
  if (!plan || !plan.snapshot || !plan.document) throw new TypeError("A migration plan is required.");
  const snapshotHash = crypto.createHash("sha256").update(plan.snapshot.bytes).digest("hex");
  if (snapshotHash !== plan.snapshot.sha256) throw new Error("Migration snapshot bytes were modified.");
  const backup = `${plan.snapshot.resolvedTarget}.bak-${stamp(options.now)}`;
  writePrivateFile(backup, plan.snapshot.bytes, { exclusive: true });
  const data = `${JSON.stringify(plan.document, null, 2)}\n`;
  let replaced = false;
  try {
    atomicReplacePrivate(plan.snapshot, data);
    replaced = true;
    const verified = readFileSnapshot(plan.snapshot.requestedPath);
    const document = JSON.parse(verified.bytes.toString("utf8"));
    if (document.version !== 2) throw new Error("Migrated configuration did not verify as version 2.");
    normalizeConfigDocument(document, plan.snapshot.requestedPath);
    verifyPrivateRegularFile(plan.snapshot.requestedPath);
  } catch (error) {
    if (replaced) {
      try {
        const current = readFileSnapshot(plan.snapshot.requestedPath);
        atomicReplacePrivate(current, fs.readFileSync(backup));
      } catch {}
    }
    throw error;
  }
  return Object.freeze({ file: plan.snapshot.requestedPath, backup });
}

module.exports = {
  applyMigrationPlan,
  effectiveConfigDocument,
  migrationPlan,
};
