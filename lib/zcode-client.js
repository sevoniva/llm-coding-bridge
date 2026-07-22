"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { localUrl } = require("./config");
const {
  atomicReplacePrivate,
  readFileSnapshot,
  stamp,
  verifyPrivateRegularFile,
  writePrivateFile,
} = require("./file-safety");

const VERSION = /^3\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STATE_VERSION = 1;
const PROVIDER_NAME = "LLM Coding Bridge";
const PROVIDER_KIND = "openai-compatible";
const PROVIDER_SOURCE = "custom";

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function zcodeVerificationStatus(input = {}) {
  const aliasCount = safeInteger(input.aliasCount);
  return Object.freeze({
    version: typeof input.version === "string" && VERSION.test(input.version) ? input.version : null,
    supported: input.supported === true,
    previewOnly: input.previewOnly === true,
    managedProviderPresent: input.managedProviderPresent === true,
    aliasCount: aliasCount ?? 0,
    privateMode: input.privateMode === true,
    lastVerifiedAt: safeInteger(input.lastVerifiedAt),
  });
}

function zcodeConfigPath(home = os.homedir()) {
  return path.join(path.resolve(home), ".zcode", "v2", "config.json");
}

function zcodeStatePath(home = os.homedir()) {
  return path.join(path.resolve(home), ".llm-coding-bridge", "zcode-state.json");
}

function installedVersion(options = {}) {
  if (typeof options.version === "string") return options.version;
  if ((options.platform || process.platform) !== "darwin") return null;
  const run = options.run || spawnSync;
  try {
    const result = run(
      "/usr/bin/defaults",
      ["read", "/Applications/ZCode.app/Contents/Info", "CFBundleShortVersionString"],
      { encoding: "utf8", shell: false, stdio: "pipe", timeout: 5000 }
    );
    if (!result || result.error || result.status !== 0) return null;
    const value = String(result.stdout || "").trim();
    return VERSION.test(value) ? value : null;
  } catch {
    return null;
  }
}

function validBridgeState(value, configFile) {
  if (!isPlainObject(value) || value.version !== STATE_VERSION) return false;
  if (typeof value.managedProviderId !== "string" || !SAFE_ID.test(value.managedProviderId)) return false;
  if (path.resolve(value.configPath || "") !== configFile) return false;
  if (!Array.isArray(value.backups) || value.backups.some((item) => typeof item !== "string")) return false;
  return value.lastVerifiedAt === undefined || safeInteger(value.lastVerifiedAt) !== null;
}

function parseJsonSnapshot(snapshot) {
  try {
    return JSON.parse(snapshot.bytes.toString("utf8"));
  } catch {
    return null;
  }
}

function configSchemaSupported(document) {
  if (!isPlainObject(document)) return false;
  if (document.provider === undefined) return true;
  if (!isPlainObject(document.provider)) return false;
  return Object.values(document.provider).every(isPlainObject);
}

function safeSnapshotWarning(error) {
  const message = String(error?.message || "");
  if (/regular file|owned by another user|symbolic link/i.test(message)) {
    return "ZCode config target must be an owned regular file.";
  }
  return "ZCode config could not be read safely.";
}

function pathEntryExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function detectZcodeState(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const configFile = path.resolve(options.configPath || zcodeConfigPath(home));
  const bridgeStateFile = path.resolve(options.statePath || zcodeStatePath(home));
  const version = installedVersion(options);
  const warnings = [];
  let previewOnly = !VERSION.test(version || "");
  if (previewOnly) warnings.push("Only detected ZCode 3.x configurations can be changed.");

  let snapshot = null;
  let document = { provider: {} };
  let exists = false;
  let privateMode = false;
  if (pathEntryExists(configFile)) {
    exists = true;
    try {
      snapshot = readFileSnapshot(configFile);
      document = parseJsonSnapshot(snapshot);
      if (document === null) {
        previewOnly = true;
        warnings.push("ZCode config is not valid JSON.");
      } else if (!configSchemaSupported(document)) {
        previewOnly = true;
        warnings.push("ZCode config schema is not supported.");
      } else if (document.provider === undefined) {
        document = { ...document, provider: {} };
      }
      privateMode = (fs.statSync(snapshot.resolvedTarget).mode & 0o777) === 0o600;
    } catch (error) {
      snapshot = null;
      document = null;
      previewOnly = true;
      warnings.push(safeSnapshotWarning(error));
    }
  }

  let stateSnapshot = null;
  let bridgeState = null;
  if (pathEntryExists(bridgeStateFile)) {
    try {
      stateSnapshot = readFileSnapshot(bridgeStateFile);
      const parsed = parseJsonSnapshot(stateSnapshot);
      if (!validBridgeState(parsed, configFile)) {
        previewOnly = true;
        warnings.push("Bridge-managed ZCode state is invalid.");
      } else {
        bridgeState = parsed;
      }
    } catch {
      previewOnly = true;
      warnings.push("Bridge-managed ZCode state could not be read safely.");
    }
  }

  const managedProvider = bridgeState && document?.provider?.[bridgeState.managedProviderId];
  return {
    home,
    version,
    supported: !previewOnly,
    previewOnly,
    warnings,
    exists,
    configPath: configFile,
    statePath: bridgeStateFile,
    snapshot,
    stateSnapshot,
    document,
    bridgeState,
    managedProviderPresent: isPlainObject(managedProvider),
    aliasCount: isPlainObject(managedProvider?.models) ? Object.keys(managedProvider.models).length : 0,
    privateMode,
    lastVerifiedAt: safeInteger(bridgeState?.lastVerifiedAt),
  };
}

function modelDocument(route) {
  const capabilities = isPlainObject(route.capabilities) ? route.capabilities : {};
  const context = Number.isSafeInteger(capabilities.contextWindow) && capabilities.contextWindow > 0
    ? capabilities.contextWindow
    : 128000;
  const input = Array.isArray(capabilities.inputModalities) && capabilities.inputModalities.length > 0
    ? [...capabilities.inputModalities]
    : ["text"];
  return {
    name: route.alias,
    ...(capabilities.reasoning === true
      ? { reasoning: { enabled: true, variants: ["low", "high"], defaultVariant: "high" } }
      : {}),
    limit: { context },
    modalities: { input, output: ["text"] },
  };
}

function managedProvider(config) {
  if (!config || !isPlainObject(config.server) || !Array.isArray(config.routes)) {
    throw new TypeError("A normalized bridge configuration is required.");
  }
  if (typeof config.server.localToken !== "string" || !config.server.localToken) {
    throw new Error("ZCode setup requires a configured local bridge token.");
  }
  const models = {};
  for (const route of config.routes) {
    if (!route || typeof route.alias !== "string" || !SAFE_ID.test(route.alias) || models[route.alias]) {
      throw new Error("ZCode model aliases must be unique safe identifiers.");
    }
    models[route.alias] = modelDocument(route);
  }
  if (Object.keys(models).length === 0) throw new Error("ZCode setup requires at least one model alias.");
  return {
    name: PROVIDER_NAME,
    kind: PROVIDER_KIND,
    options: {
      baseURL: localUrl(config, "/v1"),
      apiKey: config.server.localToken,
      apiKeyRequired: true,
    },
    enabled: true,
    source: PROVIDER_SOURCE,
    models,
  };
}

function jsonPointer(value) {
  return String(value).replace(/~/g, "~0").replace(/\//g, "~1");
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unmanagedHash(document, managedProviderId) {
  const copy = clone(document);
  if (isPlainObject(copy.provider)) delete copy.provider[managedProviderId];
  return hash(copy);
}

function planResult(input) {
  return {
    ...input,
    preview: {
      action: input.action,
      managedProviderId: input.managedProviderId || null,
      changes: input.changes || [],
      warnings: input.warnings || [],
      aliasCount: Object.keys(input.expectedProvider?.models || {}).length,
    },
  };
}

function previewOnlyPlan(action, state, warnings) {
  return planResult({
    action,
    state,
    previewOnly: true,
    noChange: true,
    changes: [],
    warnings: [...state.warnings, ...warnings],
  });
}

function planZcodeChange(options = {}) {
  const { action, config, state } = options;
  if (action !== "add" && action !== "remove") throw new Error("ZCode action must be add or remove.");
  if (!state || typeof state !== "object") throw new TypeError("Detected ZCode state is required.");
  if (state.previewOnly || !state.document) return previewOnlyPlan(action, state, []);

  const document = clone(state.document);
  const warnings = [];
  let managedProviderId = state.bridgeState?.managedProviderId || null;
  let expectedProvider = null;
  let configChanged = false;
  let stateChanged = false;
  const changes = [];

  if (action === "add") {
    try {
      expectedProvider = managedProvider(config);
    } catch (error) {
      return previewOnlyPlan(action, state, [String(error.message || "ZCode provider could not be planned.")]);
    }
    if (!managedProviderId) {
      const matches = Object.entries(document.provider).filter(([, provider]) => (
        provider.name === PROVIDER_NAME
        && provider.kind === PROVIDER_KIND
        && provider.source === PROVIDER_SOURCE
        && provider.options?.baseURL === expectedProvider.options.baseURL
      ));
      if (matches.length > 1) return previewOnlyPlan(action, state, ["Existing bridge provider matches are ambiguous."]);
      managedProviderId = matches[0]?.[0] || options.managedProviderId || `llm-coding-bridge-${crypto.randomUUID()}`;
    }
    if (!SAFE_ID.test(managedProviderId)) return previewOnlyPlan(action, state, ["Managed provider ID is invalid."]);
    const existing = document.provider[managedProviderId];
    if (JSON.stringify(existing) !== JSON.stringify(expectedProvider)) {
      document.provider[managedProviderId] = expectedProvider;
      configChanged = true;
      changes.push({ op: existing === undefined ? "add" : "replace", path: `/provider/${jsonPointer(managedProviderId)}` });
    }
    stateChanged = state.bridgeState?.managedProviderId !== managedProviderId;
  } else {
    if (!managedProviderId) {
      warnings.push("No bridge-managed state exists for ZCode.");
      return planResult({ action, state, previewOnly: false, noChange: true, changes, warnings });
    }
    if (Object.hasOwn(document.provider, managedProviderId)) {
      delete document.provider[managedProviderId];
      configChanged = true;
      changes.push({ op: "remove", path: `/provider/${jsonPointer(managedProviderId)}` });
    } else {
      warnings.push("The bridge-managed provider is already absent.");
    }
  }

  const nextBridgeState = {
    version: STATE_VERSION,
    managedProviderId,
    configPath: state.configPath,
    backups: [...(state.bridgeState?.backups || [])],
    ...(state.bridgeState?.lastVerifiedAt !== undefined
      ? { lastVerifiedAt: state.bridgeState.lastVerifiedAt }
      : {}),
  };
  return planResult({
    action,
    state,
    managedProviderId,
    expectedProvider,
    nextDocument: document,
    nextBridgeState,
    unmanagedHash: unmanagedHash(state.document, managedProviderId),
    previewOnly: false,
    noChange: !configChanged && !stateChanged,
    configChanged,
    stateChanged,
    changes,
    warnings,
  });
}

function nextBackupPath(target, now) {
  const base = `${target}.lcb-backup-${stamp(now)}`;
  let candidate = `${base}.json`;
  let index = 2;
  while (fs.existsSync(candidate)) candidate = `${base}-${index++}.json`;
  return candidate;
}

function writeOrReplace(file, snapshot, data) {
  if (snapshot) return atomicReplacePrivate(snapshot, data);
  writePrivateFile(file, data, { exclusive: true });
  return { file, target: file };
}

function restoreFile(file, previousSnapshot, backup, created) {
  if (previousSnapshot) {
    const current = readFileSnapshot(file);
    atomicReplacePrivate(current, backup ? fs.readFileSync(backup) : previousSnapshot.bytes);
  } else if (created) {
    fs.unlinkSync(file);
  }
}

function verifyAppliedPlan(plan) {
  const snapshot = readFileSnapshot(plan.state.configPath);
  const document = parseJsonSnapshot(snapshot);
  if (!configSchemaSupported(document)) throw new Error("Written ZCode config did not verify.");
  if (unmanagedHash(document, plan.managedProviderId) !== plan.unmanagedHash) {
    throw new Error("Unrelated ZCode configuration changed during apply.");
  }
  if (plan.action === "add") {
    if (JSON.stringify(document.provider[plan.managedProviderId]) !== JSON.stringify(plan.expectedProvider)) {
      throw new Error("Managed ZCode provider did not verify.");
    }
  } else if (Object.hasOwn(document.provider, plan.managedProviderId)) {
    throw new Error("Managed ZCode provider removal did not verify.");
  }
  verifyPrivateRegularFile(plan.state.configPath);
}

function applyZcodePlan(plan, options = {}) {
  if (!plan || typeof plan !== "object") throw new TypeError("A ZCode change plan is required.");
  if (plan.previewOnly) throw new Error("Preview-only ZCode plans cannot be applied.");
  if (plan.noChange) return Object.freeze({ changed: false, backup: null, file: plan.state.configPath });

  let backup = null;
  let configApplied = false;
  let configCreated = false;
  let stateApplied = false;
  let stateCreated = false;
  if (plan.configChanged && plan.state.snapshot) {
    backup = nextBackupPath(plan.state.snapshot.resolvedTarget, options.now);
    writePrivateFile(backup, plan.state.snapshot.bytes, { exclusive: true });
  }
  const nextState = {
    ...plan.nextBridgeState,
    backups: [...plan.nextBridgeState.backups, ...(backup ? [backup] : [])],
    lastVerifiedAt: Date.now(),
  };

  try {
    if (plan.configChanged) {
      writeOrReplace(
        plan.state.configPath,
        plan.state.snapshot,
        `${JSON.stringify(plan.nextDocument, null, 2)}\n`
      );
      configApplied = true;
      configCreated = !plan.state.snapshot;
    }
    if (plan.configChanged || plan.stateChanged) {
      writeOrReplace(
        plan.state.statePath,
        plan.state.stateSnapshot,
        `${JSON.stringify(nextState, null, 2)}\n`
      );
      stateApplied = true;
      stateCreated = !plan.state.stateSnapshot;
    }
    verifyAppliedPlan(plan);
    const verifiedState = JSON.parse(fs.readFileSync(plan.state.statePath, "utf8"));
    if (!validBridgeState(verifiedState, plan.state.configPath)) throw new Error("Bridge-managed ZCode state did not verify.");
    verifyPrivateRegularFile(plan.state.statePath);
  } catch (error) {
    if (stateApplied) {
      try { restoreFile(plan.state.statePath, plan.state.stateSnapshot, null, stateCreated); } catch {}
    }
    if (configApplied) {
      try { restoreFile(plan.state.configPath, plan.state.snapshot, backup, configCreated); } catch {}
    }
    throw error;
  }

  return Object.freeze({ changed: true, backup, file: plan.state.configPath, stateFile: plan.state.statePath });
}

function validateRollbackBackup(state, backup) {
  const requested = path.resolve(backup);
  const recorded = new Set((state.bridgeState?.backups || []).map((item) => path.resolve(item)));
  if (!recorded.has(requested)) throw new Error("Rollback requires a recorded bridge-created backup.");
  const metadata = fs.lstatSync(requested);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Rollback backup must be a regular file.");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Rollback backup must be owned by the current user.");
  }
  const targetDirectory = fs.realpathSync(path.dirname(state.snapshot.resolvedTarget));
  if (path.dirname(fs.realpathSync(requested)) !== targetDirectory) {
    throw new Error("Rollback backup must be stored beside the ZCode config target.");
  }
  return readFileSnapshot(requested);
}

function planZcodeRollback(options = {}) {
  const { state } = options;
  if (!state || state.previewOnly || !state.snapshot || !state.bridgeState) {
    throw new Error("Rollback requires supported bridge-managed ZCode state.");
  }
  const backupSnapshot = validateRollbackBackup(state, options.backup);
  const nextDocument = parseJsonSnapshot(backupSnapshot);
  if (!configSchemaSupported(nextDocument)) throw new Error("Rollback backup has an unsupported ZCode schema.");
  return planResult({
    action: "rollback",
    state,
    backupSnapshot,
    nextDocument,
    managedProviderId: state.bridgeState.managedProviderId,
    nextBridgeState: clone(state.bridgeState),
    previewOnly: false,
    noChange: backupSnapshot.sha256 === state.snapshot.sha256,
    changes: [{ op: "replace", path: "/" }],
    warnings: [],
  });
}

function applyZcodeRollback(plan, options = {}) {
  if (!plan || plan.action !== "rollback") throw new TypeError("A ZCode rollback plan is required.");
  if (plan.previewOnly) throw new Error("Preview-only ZCode plans cannot be applied.");
  if (plan.noChange) return Object.freeze({ changed: false, backup: null, file: plan.state.configPath });
  const backup = nextBackupPath(plan.state.snapshot.resolvedTarget, options.now);
  writePrivateFile(backup, plan.state.snapshot.bytes, { exclusive: true });
  let configApplied = false;
  let stateApplied = false;
  try {
    atomicReplacePrivate(plan.state.snapshot, plan.backupSnapshot.bytes);
    configApplied = true;
    const restored = readFileSnapshot(plan.state.configPath);
    if (!configSchemaSupported(parseJsonSnapshot(restored))) throw new Error("Restored ZCode config did not verify.");
    verifyPrivateRegularFile(plan.state.configPath);

    const nextState = {
      ...plan.nextBridgeState,
      backups: [...plan.nextBridgeState.backups, backup],
      lastVerifiedAt: Date.now(),
    };
    writeOrReplace(plan.state.statePath, plan.state.stateSnapshot, `${JSON.stringify(nextState, null, 2)}\n`);
    stateApplied = true;
    verifyPrivateRegularFile(plan.state.statePath);
  } catch (error) {
    if (stateApplied) {
      try { restoreFile(plan.state.statePath, plan.state.stateSnapshot, null, false); } catch {}
    }
    if (configApplied) {
      try {
        const current = readFileSnapshot(plan.state.configPath);
        atomicReplacePrivate(current, fs.readFileSync(backup));
      } catch {}
    }
    throw error;
  }
  return Object.freeze({ changed: true, backup, file: plan.state.configPath });
}

module.exports = {
  applyZcodePlan,
  applyZcodeRollback,
  detectZcodeState,
  planZcodeChange,
  planZcodeRollback,
  zcodeConfigPath,
  zcodeStatePath,
  zcodeVerificationStatus,
};
