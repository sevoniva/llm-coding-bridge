"use strict";

const net = require("node:net");
const { types } = require("node:util");

const DEFAULT_API_KEY_TTL_MS = 10 * 60 * 1000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SSE_EVENT_BYTES = 1024 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 1000;

const RELIABILITY_LEAVES = Object.freeze([
  "headerTimeoutMs",
  "firstDataTimeoutMs",
  "idleTimeoutMs",
  "nonStreamingTotalTimeoutMs",
  "streamingTotalTimeoutMs",
  "downstreamHeartbeatIntervalMs",
]);
const RELIABILITY_LEAF_SET = new Set(RELIABILITY_LEAVES);
const RELIABILITY_POLICIES = Object.freeze({
  stable: Object.freeze({
    headerTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
    firstDataTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
    idleTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
    nonStreamingTotalTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
    streamingTotalTimeoutMs: 0,
    downstreamHeartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  }),
  "long-thinking": Object.freeze({
    headerTimeoutMs: 1800000,
    firstDataTimeoutMs: 1800000,
    idleTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
    nonStreamingTotalTimeoutMs: 1800000,
    streamingTotalTimeoutMs: 0,
    downstreamHeartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  }),
});
const POLICY_NAMES = new Set(Object.keys(RELIABILITY_POLICIES));
const SUPPORTED_INPUT_MODALITIES = new Set(["text", "image", "audio"]);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function invalid(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePlainData(input) {
  const active = new Set();

  function visit(value) {
    if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) invalid("Configuration must contain plain data only.");
      return value;
    }
    if (typeof value !== "object") invalid("Configuration must contain plain data only.");
    if (types.isProxy(value)) invalid("Configuration must contain plain data only.");
    if (active.has(value)) invalid("Configuration must contain plain data only.");

    let prototype;
    let descriptors;
    try {
      prototype = Object.getPrototypeOf(value);
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      invalid("Configuration must contain plain data only.");
    }
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      invalid("Configuration must contain plain data only.");
    }
    if (Array.isArray(value) && prototype !== Array.prototype) {
      invalid("Configuration must contain plain data only.");
    }

    active.add(value);
    try {
      const ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.some((key) => typeof key === "symbol")) invalid("Configuration must contain plain data only.");
      if (Array.isArray(value)) {
        const keys = ownKeys;
        if (keys.some((key) => key !== "length" && !/^(0|[1-9]\d*)$/.test(key))) {
          invalid("Configuration must contain plain data only.");
        }
        const length = descriptors.length.value;
        if (!Number.isSafeInteger(length) || length < 0) invalid("Configuration must contain plain data only.");
        const output = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[index];
          if (!descriptor || descriptor.get || descriptor.set) invalid("Configuration must contain plain data only.");
          output.push(visit(descriptor.value));
        }
        return output;
      }

      const output = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable || descriptor.get || descriptor.set) {
          invalid("Configuration must contain plain data only.");
        }
        Object.defineProperty(output, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: visit(descriptor.value),
        });
      }
      return output;
    } finally {
      active.delete(value);
    }
  }

  try {
    return visit(input);
  } catch (error) {
    if (error instanceof Error && error.message === "Configuration must contain plain data only.") throw error;
    throw new Error("Configuration must contain plain data only.");
  }
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function requirePlainObject(value, message) {
  if (!isPlainObject(value)) invalid(message);
  return value;
}

function requireNonEmptyString(value, message) {
  if (typeof value !== "string" || !value.trim()) invalid(message);
  return value;
}

function requireSafeIdentifier(value, message) {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) invalid(message);
  return value;
}

function positiveInteger(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) invalid(`${name} must be a positive integer.`);
  return number;
}

function nonNegativeInteger(value, fallback, name) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) invalid(`${name} must be a non-negative integer.`);
  return number;
}

function strictPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${name} must be a positive integer.`);
  return value;
}

function strictNonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${name} must be a non-negative integer.`);
  return value;
}

function isLoopbackHostname(hostname) {
  let host = String(hostname || "").toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "localhost" || host === "localhost.") return true;
  if (net.isIP(host) === 4) return host.split(".")[0] === "127";
  if (net.isIP(host) !== 6) return false;
  if (host === "::1") return true;
  const dotted = host.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) return Number(dotted[1]) === 127;
  const hexadecimal = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hexadecimal) return false;
  const address = (Number.parseInt(hexadecimal[1], 16) * 65536) + Number.parseInt(hexadecimal[2], 16);
  return address >= 0x7f000000 && address <= 0x7fffffff;
}

function normalizeBaseUrl(value, name) {
  requireNonEmptyString(value, `${name} must be a non-empty URL.`);
  const authority = value.match(/^[A-Za-z][A-Za-z\d+.-]*:\/\/([^/?#]*)/);
  if (authority && authority[1].includes("@")) invalid(`${name} must not contain URL credentials.`);
  if (value.includes("#")) invalid(`${name} must not contain a URL fragment.`);
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid(`${name} must be a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") invalid(`${name} must use HTTPS or loopback HTTP.`);
  if (url.username || url.password) invalid(`${name} must not contain URL credentials.`);
  if (url.hash) invalid(`${name} must not contain a URL fragment.`);
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    invalid(`${name} must use HTTPS or loopback HTTP.`);
  }

  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname}${url.search}`;
}

function validateReliabilityLeaf(name, value, label) {
  if (name === "streamingTotalTimeoutMs" || name === "downstreamHeartbeatIntervalMs") {
    return strictNonNegativeInteger(value, `${label}.${name}`);
  }
  return strictPositiveInteger(value, `${label}.${name}`);
}

function normalizeReliabilityOverrides(value, label) {
  if (value === undefined) return {};
  requirePlainObject(value, `${label} must be an object.`);
  const output = {};
  for (const [key, leaf] of Object.entries(value)) {
    if (!RELIABILITY_LEAF_SET.has(key)) invalid(`${label} contains an unsupported reliability field.`);
    output[key] = validateReliabilityLeaf(key, leaf, label);
  }
  return output;
}

function normalizePolicyName(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !POLICY_NAMES.has(value)) {
    invalid(`${label} must name stable or long-thinking.`);
  }
  return value;
}

function normalizeProfile(input) {
  if (input === undefined) return {};
  const profile = clonePlainData(input);
  requirePlainObject(profile, "Profile must be a plain data object.");
  for (const key of Object.keys(profile)) {
    if (key !== "reliabilityPolicies") invalid("Profile contains an unsupported field.");
  }
  if (profile.reliabilityPolicies === undefined) return {};
  requirePlainObject(profile.reliabilityPolicies, "Profile reliabilityPolicies must be an object.");
  const output = {};
  for (const [policyName, overrides] of Object.entries(profile.reliabilityPolicies)) {
    if (!POLICY_NAMES.has(policyName)) invalid("Profile contains an unsupported reliability policy.");
    output[policyName] = normalizeReliabilityOverrides(overrides, `profile.reliabilityPolicies.${policyName}`);
  }
  return output;
}

function resolveReliability(policyName, profilePolicies, ...userLayers) {
  const values = {};
  const annotated = {};
  for (const leaf of RELIABILITY_LEAVES) {
    values[leaf] = RELIABILITY_POLICIES[policyName][leaf];
    annotated[leaf] = { value: values[leaf], source: "built_in" };
  }
  for (const [leaf, value] of Object.entries(profilePolicies[policyName] || {})) {
    values[leaf] = value;
    annotated[leaf] = { value, source: "profile" };
  }
  for (const layer of userLayers) {
    for (const [leaf, value] of Object.entries(layer)) {
      values[leaf] = value;
      annotated[leaf] = { value, source: "user" };
    }
  }
  return { values, annotated };
}

function normalizeCapabilities(value, label) {
  if (value === undefined) {
    return { inputModalities: ["text"], reasoning: false };
  }
  requirePlainObject(value, `${label} capabilities must be an object.`);
  const output = { ...value };
  if (value.contextWindow !== undefined) {
    output.contextWindow = strictPositiveInteger(value.contextWindow, `${label}.capabilities.contextWindow`);
  }
  if (value.inputModalities === undefined) {
    output.inputModalities = ["text"];
  } else {
    if (!Array.isArray(value.inputModalities) || value.inputModalities.length === 0) {
      invalid(`${label}.capabilities.inputModalities must be a non-empty array.`);
    }
    const seen = new Set();
    output.inputModalities = value.inputModalities.map((modality) => {
      if (typeof modality !== "string" || !SUPPORTED_INPUT_MODALITIES.has(modality) || seen.has(modality)) {
        invalid(`${label}.capabilities.inputModalities must contain unique supported strings.`);
      }
      seen.add(modality);
      return modality;
    });
  }
  if (value.reasoning === undefined) {
    output.reasoning = false;
  } else if (typeof value.reasoning !== "boolean") {
    invalid(`${label}.capabilities.reasoning must be a boolean.`);
  }
  return output;
}

function validateLegacyCredential(upstream) {
  if (upstream.apiKeySource && upstream.apiKeySource !== "client") {
    invalid('upstream.apiKeySource must be "client" when set.');
  }
  if (upstream.apiKeySource !== "client" && !upstream.apiKeyEnv && !upstream.apiKeyCommand) {
    invalid("Missing upstream.apiKeyEnv, upstream.apiKeyCommand, or upstream.apiKeySource.");
  }
}

function legacyCredential(upstream) {
  if (upstream.apiKeySource === "client") return { source: "client" };
  if (upstream.apiKeyEnv) return { source: "env", env: upstream.apiKeyEnv };
  return { source: "command", command: upstream.apiKeyCommand };
}

function normalizeVersionOne(document, configPath, profilePolicies) {
  const rawSingle = document.upstream === undefined || document.upstream === null ? null : document.upstream;
  if (rawSingle !== null) requirePlainObject(rawSingle, "upstream must be an object.");
  if (document.upstreams !== undefined && !Array.isArray(document.upstreams)) {
    invalid("upstreams must be an array.");
  }
  const rawList = document.upstreams || [];
  if (rawList.some((route) => !isPlainObject(route))) invalid("Each upstream must be an object.");
  const inputs = rawSingle ? [rawSingle, ...rawList] : rawList;
  if (inputs.length === 0) invalid("Missing upstream or upstreams.");

  const rootPolicy = normalizePolicyName(document.reliabilityPolicy, "reliabilityPolicy") || "stable";
  const rootReliability = normalizeReliabilityOverrides(document.reliability, "reliability");
  const credentials = {};
  const allEffectiveRoutes = [];
  const allRoutes = inputs.map((upstream, index) => {
    requireNonEmptyString(upstream.baseUrl, "Missing upstream.baseUrl.");
    requireNonEmptyString(upstream.model, "Missing upstream.model.");
    validateLegacyCredential(upstream);
    const policyName = normalizePolicyName(upstream.reliabilityPolicy, "upstream.reliabilityPolicy") || rootPolicy;
    const routeOverrides = normalizeReliabilityOverrides(upstream.reliability, "upstream.reliability");
    const reliability = resolveReliability(policyName, profilePolicies, rootReliability, routeOverrides);
    const credentialRef = `legacy-${index + 1}`;
    const credential = legacyCredential(upstream);
    credentials[credentialRef] = credential;
    const providerName = typeof upstream.name === "string" && upstream.name.trim() ? upstream.name : "Upstream";
    const route = {
      ...upstream,
      alias: upstream.model,
      upstreamModel: upstream.model,
      model: upstream.model,
      providerId: credentialRef,
      providerName,
      name: providerName,
      baseUrl: normalizeBaseUrl(upstream.baseUrl, "upstream.baseUrl"),
      credentialRef,
      credential,
      capabilities: normalizeCapabilities(upstream.capabilities, "upstream"),
      reliability: reliability.values,
      timeoutMs: positiveInteger(
        upstream.timeoutMs,
        reliability.values.nonStreamingTotalTimeoutMs,
        "upstream.timeoutMs"
      ),
      maxResponseBytes: positiveInteger(upstream.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "upstream.maxResponseBytes"),
      maxSseEventBytes: positiveInteger(upstream.maxSseEventBytes, DEFAULT_MAX_SSE_EVENT_BYTES, "upstream.maxSseEventBytes"),
      heartbeatIntervalMs: nonNegativeInteger(
        upstream.heartbeatIntervalMs,
        reliability.values.downstreamHeartbeatIntervalMs,
        "upstream.heartbeatIntervalMs"
      ),
    };
    allEffectiveRoutes.push({ alias: route.alias, reliabilityPolicy: policyName, reliability: reliability.annotated });
    return route;
  });
  const singleOffset = rawSingle ? 1 : 0;
  const normalizedSingle = rawSingle ? allRoutes[0] : null;
  const normalizedList = allRoutes.slice(singleOffset);
  const routes = normalizedList.length > 0 ? normalizedList : [normalizedSingle];
  const effectiveRoutes = normalizedList.length > 0
    ? allEffectiveRoutes.slice(singleOffset)
    : [allEffectiveRoutes[0]];

  return deepFreeze({
    path: configPath,
    version: 1,
    routes,
    upstreams: routes,
    defaultUpstream: normalizedSingle || routes[0],
    credentials,
    effective: { routes: effectiveRoutes },
  });
}

function projectCredential(route, credential) {
  if (credential.source === "env" && typeof credential.env === "string") route.apiKeyEnv = credential.env;
  if (credential.source === "command" && credential.command !== undefined) route.apiKeyCommand = credential.command;
  if (credential.source === "client") route.apiKeySource = "client";
}

function normalizeVersionTwo(document, configPath, profilePolicies) {
  if (!Array.isArray(document.providers) || document.providers.length === 0) {
    invalid("Version 2 providers must be a non-empty array.");
  }
  requirePlainObject(document.credentials, "Version 2 credentials must be an object.");
  for (const descriptor of Object.values(document.credentials)) {
    requirePlainObject(descriptor, "Each credential descriptor must be an object.");
  }

  const rootPolicy = normalizePolicyName(document.reliabilityPolicy, "reliabilityPolicy") || "stable";
  const rootReliability = normalizeReliabilityOverrides(document.reliability, "reliability");
  const providerIds = new Set();
  const aliases = new Set();
  const routes = [];
  const effectiveRoutes = [];

  for (let providerIndex = 0; providerIndex < document.providers.length; providerIndex += 1) {
    const provider = document.providers[providerIndex];
    requirePlainObject(provider, "Each provider must be an object.");
    const label = `providers[${providerIndex}]`;
    const providerId = requireSafeIdentifier(provider.id, `${label}.id must be a non-empty safe identifier.`);
    if (providerIds.has(providerId)) invalid("Duplicate provider id.");
    providerIds.add(providerId);
    const providerName = requireNonEmptyString(provider.name, `${label}.name must be a non-empty display name.`);
    const baseUrl = normalizeBaseUrl(provider.baseUrl, `${label}.baseUrl`);
    if (!Array.isArray(provider.models) || provider.models.length === 0) {
      invalid(`${label}.models must be a non-empty array.`);
    }
    const providerPolicy = normalizePolicyName(provider.reliabilityPolicy, `${label}.reliabilityPolicy`) || rootPolicy;
    const providerReliability = normalizeReliabilityOverrides(provider.reliability, `${label}.reliability`);

    for (let modelIndex = 0; modelIndex < provider.models.length; modelIndex += 1) {
      const model = provider.models[modelIndex];
      requirePlainObject(model, "Each model must be an object.");
      const modelLabel = `${label}.models[${modelIndex}]`;
      const alias = requireSafeIdentifier(model.alias, `${modelLabel}.alias must be a non-empty safe identifier.`);
      if (aliases.has(alias)) invalid("Duplicate model alias.");
      aliases.add(alias);
      const upstreamModel = requireNonEmptyString(
        model.upstreamModel,
        `${modelLabel}.upstreamModel must be a non-empty string.`
      );
      const credentialRef = requireNonEmptyString(
        model.credentialRef,
        `${modelLabel}.credentialRef must be a non-empty string.`
      );
      if (!Object.prototype.hasOwnProperty.call(document.credentials, credentialRef)) {
        invalid("A model credential reference has no descriptor.");
      }
      const credential = document.credentials[credentialRef];
      requirePlainObject(credential, "Each credential descriptor must be an object.");
      const policyName = normalizePolicyName(model.reliabilityPolicy, `${modelLabel}.reliabilityPolicy`) || providerPolicy;
      const modelReliability = normalizeReliabilityOverrides(model.reliability, `${modelLabel}.reliability`);
      const reliability = resolveReliability(
        policyName,
        profilePolicies,
        rootReliability,
        providerReliability,
        modelReliability
      );
      const route = {
        alias,
        upstreamModel,
        model: upstreamModel,
        providerId,
        providerName,
        name: providerName,
        baseUrl,
        credentialRef,
        credential,
        capabilities: normalizeCapabilities(model.capabilities, modelLabel),
        reliability: reliability.values,
        timeoutMs: reliability.values.nonStreamingTotalTimeoutMs,
        heartbeatIntervalMs: reliability.values.downstreamHeartbeatIntervalMs,
        maxResponseBytes: positiveInteger(
          model.maxResponseBytes ?? provider.maxResponseBytes,
          DEFAULT_MAX_RESPONSE_BYTES,
          `${modelLabel}.maxResponseBytes`
        ),
        maxSseEventBytes: positiveInteger(
          model.maxSseEventBytes ?? provider.maxSseEventBytes,
          DEFAULT_MAX_SSE_EVENT_BYTES,
          `${modelLabel}.maxSseEventBytes`
        ),
        apiKeyCacheTtlMs: nonNegativeInteger(
          model.apiKeyCacheTtlMs ?? provider.apiKeyCacheTtlMs,
          DEFAULT_API_KEY_TTL_MS,
          `${modelLabel}.apiKeyCacheTtlMs`
        ),
      };
      projectCredential(route, credential);
      routes.push(route);
      effectiveRoutes.push({ alias, reliabilityPolicy: policyName, reliability: reliability.annotated });
    }
  }

  return deepFreeze({
    path: configPath,
    version: 2,
    routes,
    upstreams: routes,
    defaultUpstream: routes[0],
    credentials: document.credentials,
    effective: { routes: effectiveRoutes },
  });
}

function normalizeConfigDocument(input, configPath, options = {}) {
  const document = clonePlainData(input);
  requirePlainObject(document, "Configuration root must be a plain object.");
  const normalizedOptions = clonePlainData(options);
  requirePlainObject(normalizedOptions, "Normalization options must be a plain data object.");
  for (const key of Object.keys(normalizedOptions)) {
    if (key !== "profile") invalid("Normalization options contain an unsupported field.");
  }
  const profilePolicies = normalizeProfile(normalizedOptions.profile);
  const version = document.version === undefined ? 1 : document.version;
  if (version !== 1 && version !== 2) invalid("Unsupported configuration version.");
  if (version === 1) return normalizeVersionOne(document, configPath, profilePolicies);
  return normalizeVersionTwo(document, configPath, profilePolicies);
}

module.exports = {
  normalizeConfigDocument,
};
