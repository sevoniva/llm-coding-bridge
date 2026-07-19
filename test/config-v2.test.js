"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { normalizeConfigDocument } = require("../lib/config-v2");
const { getApiKey, loadConfig, normalizeServer, resolveUpstream, upstreamUrl } = require("../lib/config");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function v2Document() {
  return {
    version: 2,
    reliabilityPolicy: "stable",
    providers: [
      {
        id: "provider-a",
        name: "Provider A",
        baseUrl: "https://api.example.com/shared/v1/",
        models: [
          {
            alias: "coding-fast",
            upstreamModel: "provider-model-id-a",
            credentialRef: "model-a",
            capabilities: {
              contextWindow: 131072,
              inputModalities: ["text", "image"],
              reasoning: true,
            },
          },
          {
            alias: "coding-strong",
            upstreamModel: "provider-model-id-b",
            credentialRef: "model-b",
            reliabilityPolicy: "long-thinking",
          },
        ],
      },
    ],
    credentials: {
      "model-a": { source: "env", env: "MODEL_A_API_KEY" },
      "model-b": {
        source: "command",
        command: { command: "/usr/bin/printf", args: ["synthetic-token"] },
      },
      "future-model": { source: "client", metadata: { note: "unused descriptor" } },
    },
  };
}

function assertFrozenTree(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertFrozenTree(child, seen);
}

function expectInvalid(document, pattern, options, configPath = "/tmp/generic-config.json") {
  assert.throws(
    () => normalizeConfigDocument(document, configPath, options),
    pattern
  );
}

function testVersionTwoNormalization() {
  const document = v2Document();
  const before = clone(document);
  const config = normalizeConfigDocument(document, "/tmp/generic-config.json");

  assert.deepEqual(config.routes.map((route) => ({
    alias: route.alias,
    upstreamModel: route.upstreamModel,
    credentialRef: route.credentialRef,
  })), [
    { alias: "coding-fast", upstreamModel: "provider-model-id-a", credentialRef: "model-a" },
    { alias: "coding-strong", upstreamModel: "provider-model-id-b", credentialRef: "model-b" },
  ]);
  assert.equal(config.version, 2);
  assert.equal(config.upstreams, config.routes);
  assert.equal(config.defaultUpstream, config.routes[0]);
  assert.equal(config.routes[0].model, "provider-model-id-a");
  assert.equal(config.routes[0].providerId, "provider-a");
  assert.equal(config.routes[0].providerName, "Provider A");
  assert.equal(config.routes[0].name, "Provider A");
  assert.equal(config.routes[0].baseUrl, "https://api.example.com/shared/v1");
  assert.deepEqual(config.routes[0].capabilities, {
    contextWindow: 131072,
    inputModalities: ["text", "image"],
    reasoning: true,
  });
  assert.deepEqual(config.routes[1].capabilities, {
    inputModalities: ["text"],
    reasoning: false,
  });
  assert.deepEqual(config.routes[0].reliability, {
    headerTimeoutMs: 600000,
    firstDataTimeoutMs: 600000,
    idleTimeoutMs: 600000,
    nonStreamingTotalTimeoutMs: 600000,
    streamingTotalTimeoutMs: 0,
    downstreamHeartbeatIntervalMs: 15000,
  });
  assert.deepEqual(config.routes[1].reliability, {
    headerTimeoutMs: 1800000,
    firstDataTimeoutMs: 1800000,
    idleTimeoutMs: 600000,
    nonStreamingTotalTimeoutMs: 1800000,
    streamingTotalTimeoutMs: 0,
    downstreamHeartbeatIntervalMs: 15000,
  });
  assert.equal(config.routes[0].timeoutMs, 600000);
  assert.equal(config.routes[0].heartbeatIntervalMs, 15000);
  assert.equal(config.routes[0].maxResponseBytes, 32 * 1024 * 1024);
  assert.equal(config.routes[0].maxSseEventBytes, 1024 * 1024);
  assert.deepEqual(config.effective.routes.map((route) => ({
    alias: route.alias,
    reliabilityPolicy: route.reliabilityPolicy,
  })), [
    { alias: "coding-fast", reliabilityPolicy: "stable" },
    { alias: "coding-strong", reliabilityPolicy: "long-thinking" },
  ]);
  for (const leaf of Object.values(config.effective.routes[0].reliability)) {
    assert.deepEqual(Object.keys(leaf).sort(), ["source", "value"]);
    assert.equal(leaf.source, "built_in");
  }
  assert.deepEqual(document, before);
  assert.notEqual(config.credentials, document.credentials);
  assert.notEqual(config.routes[0].credential, document.credentials["model-a"]);
  assert.notEqual(config.routes[0].capabilities, document.providers[0].models[0].capabilities);
  assertFrozenTree(config);

  document.credentials["model-a"].env = "MUTATED_ENV";
  document.providers[0].models[0].capabilities.inputModalities.push("audio");
  assert.equal(config.routes[0].credential.env, "MODEL_A_API_KEY");
  assert.deepEqual(config.routes[0].capabilities.inputModalities, ["text", "image"]);
}

function testReliabilityResolutionAndProvenance() {
  const document = v2Document();
  document.reliabilityPolicy = "long-thinking";
  document.reliability = { firstDataTimeoutMs: 700001 };
  document.providers[0].reliability = { idleTimeoutMs: 700002 };
  document.providers[0].models[0].reliability = {
    nonStreamingTotalTimeoutMs: 700003,
    streamingTotalTimeoutMs: 700004,
  };
  const profile = {
    reliabilityPolicies: {
      stable: { downstreamHeartbeatIntervalMs: 16000 },
      "long-thinking": { headerTimeoutMs: 1900000 },
    },
  };
  const config = normalizeConfigDocument(document, "/tmp/generic-config.json", { profile });
  const route = config.routes[0];
  const effective = config.effective.routes[0];

  assert.equal(effective.reliabilityPolicy, "long-thinking");
  assert.deepEqual(route.reliability, {
    headerTimeoutMs: 1900000,
    firstDataTimeoutMs: 700001,
    idleTimeoutMs: 700002,
    nonStreamingTotalTimeoutMs: 700003,
    streamingTotalTimeoutMs: 700004,
    downstreamHeartbeatIntervalMs: 15000,
  });
  assert.deepEqual(effective.reliability.headerTimeoutMs, { value: 1900000, source: "profile" });
  assert.deepEqual(effective.reliability.firstDataTimeoutMs, { value: 700001, source: "user" });
  assert.deepEqual(effective.reliability.idleTimeoutMs, { value: 700002, source: "user" });
  assert.deepEqual(effective.reliability.nonStreamingTotalTimeoutMs, { value: 700003, source: "user" });
  assert.deepEqual(effective.reliability.streamingTotalTimeoutMs, { value: 700004, source: "user" });
  assert.deepEqual(effective.reliability.downstreamHeartbeatIntervalMs, { value: 15000, source: "built_in" });
  assert.equal(Object.isFrozen(profile), false);
  assert.equal(Object.isFrozen(profile.reliabilityPolicies), false);
}

function testVersionOneCompatibility() {
  const command = { command: "/usr/bin/printf", args: ["synthetic-token"] };
  const single = normalizeConfigDocument({
    upstream: {
      name: "Legacy Single",
      baseUrl: "https://legacy.example.com/v1/",
      model: "legacy-one",
      apiKeyCommand: command,
      apiKeyCacheTtlMs: 1234,
      timeoutMs: 2345,
      maxResponseBytes: 3456,
      maxSseEventBytes: 4567,
      heartbeatIntervalMs: 0,
    },
  }, "/tmp/v1-single.json");
  assert.equal(single.version, 1);
  assert.equal(single.routes, single.upstreams);
  assert.equal(single.routes[0].alias, "legacy-one");
  assert.equal(single.routes[0].upstreamModel, "legacy-one");
  assert.equal(single.routes[0].model, "legacy-one");
  assert.equal(single.routes[0].baseUrl, "https://legacy.example.com/v1");
  assert.equal(single.routes[0].apiKeyCacheTtlMs, 1234);
  assert.equal(single.routes[0].timeoutMs, 2345);
  assert.equal(single.routes[0].maxResponseBytes, 3456);
  assert.equal(single.routes[0].maxSseEventBytes, 4567);
  assert.equal(single.routes[0].heartbeatIntervalMs, 0);
  assert.deepEqual(single.routes[0].apiKeyCommand, command);
  assert.notEqual(single.routes[0].apiKeyCommand, command);
  assert.equal(resolveUpstream(single, "arbitrary-client-model"), single.routes[0]);

  const multiple = normalizeConfigDocument({
    version: 1,
    upstreams: [
      { baseUrl: "https://a.example.com/v1", model: "legacy-a", apiKeyEnv: "LEGACY_A_KEY" },
      { baseUrl: "https://b.example.com/v1", model: "legacy-b", apiKeySource: "client" },
    ],
  }, "/tmp/v1-multiple.json");
  assert.equal(resolveUpstream(multiple, "legacy-b"), multiple.routes[1]);
  assert.equal(resolveUpstream(multiple, "unknown"), null);
  assert.equal(resolveUpstream(multiple, ""), null);

  const both = normalizeConfigDocument({
    upstream: {
      baseUrl: "https://default.example.com/v1",
      model: "legacy-default",
      apiKeyEnv: "LEGACY_DEFAULT_KEY",
    },
    upstreams: [
      { baseUrl: "https://a.example.com/v1", model: "legacy-a", apiKeyEnv: "LEGACY_A_KEY" },
      { baseUrl: "https://b.example.com/v1", model: "legacy-b", apiKeyEnv: "LEGACY_B_KEY" },
    ],
  }, "/tmp/v1-both.json");
  assert.deepEqual(both.routes.map((route) => route.alias), ["legacy-a", "legacy-b"]);
  assert.equal(both.routes, both.upstreams);
  assert.equal(both.defaultUpstream.alias, "legacy-default");
  assert.equal(resolveUpstream(both, "legacy-default"), null);
}

function testVersionOneLanAndUnusedListCompatibility() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-config-v1-compat-"));
  try {
    const lanPath = path.join(directory, "lan.json");
    fs.writeFileSync(lanPath, JSON.stringify({
      upstream: {
        baseUrl: "http://192.168.1.20:11434/v1",
        model: "legacy-lan",
        apiKeyEnv: "LEGACY_LAN_KEY",
      },
    }));
    const lan = loadConfig(lanPath);
    assert.equal(lan.routes[0].baseUrl, "http://192.168.1.20:11434/v1");
    assert.equal(upstreamUrl(lan.routes[0]), "http://192.168.1.20:11434/v1/chat/completions");

    const unusedListPath = path.join(directory, "unused-list.json");
    fs.writeFileSync(unusedListPath, JSON.stringify({
      upstream: {
        baseUrl: "https://legacy.example.com/v1",
        model: "legacy-single",
        apiKeyEnv: "LEGACY_SINGLE_KEY",
      },
      upstreams: "unused-in-version-one",
    }));
    const unusedList = loadConfig(unusedListPath);
    assert.equal(unusedList.routes.length, 1);
    assert.equal(unusedList.defaultUpstream.alias, "legacy-single");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testExactVersionTwoResolution() {
  const config = normalizeConfigDocument(v2Document(), "/tmp/v2.json");
  assert.equal(resolveUpstream(config, "coding-fast"), config.routes[0]);
  assert.equal(resolveUpstream(config, "provider-model-id-a"), null);
  assert.equal(resolveUpstream(config, "unknown"), null);

  const one = v2Document();
  one.providers[0].models = [one.providers[0].models[0]];
  const single = normalizeConfigDocument(one, "/tmp/v2-one.json");
  assert.equal(resolveUpstream(single, "coding-fast"), single.routes[0]);
  assert.equal(resolveUpstream(single, "unknown"), null);
  assert.equal(resolveUpstream(single, ""), null);
}

function testLoadConfigIntegrationAndNoRewrite() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-config-v2-"));
  try {
    const configPath = path.join(directory, "config.json");
    const source = `${JSON.stringify({
      ...v2Document(),
      server: { host: "127.0.0.1", port: 0, heartbeatIntervalMs: 0 },
    }, null, 2)}\n`;
    fs.writeFileSync(configPath, source, { mode: 0o600 });
    const before = fs.statSync(configPath);
    const config = loadConfig(configPath);
    const after = fs.statSync(configPath);

    assert.equal(config.path, configPath);
    assert.equal(config.version, 2);
    assert.equal(config.server.port, 0);
    assert.equal(config.server.heartbeatIntervalMs, 0);
    assert.equal(config.routes, config.upstreams);
    assert.equal(config.defaultUpstream, config.routes[0]);
    assert.equal(fs.readFileSync(configPath, "utf8"), source);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);

    process.env.MODEL_A_API_KEY = "synthetic-projected-token";
    assert.equal(getApiKey(config.routes[0]), "synthetic-projected-token");
    delete process.env.MODEL_A_API_KEY;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testShapeAndIdentifierValidation() {
  for (const root of [null, [], "text", 1, true]) expectInvalid(root, /configuration root/i);
  for (const version of [0, 3, "2", false]) {
    const document = v2Document();
    document.version = version;
    expectInvalid(document, /unsupported configuration version/i);
  }
  for (const providers of [undefined, null, {}, [], "provider"]) {
    const document = v2Document();
    document.providers = providers;
    expectInvalid(document, /providers/i);
  }
  for (const credentials of [undefined, null, [], "credentials"]) {
    const document = v2Document();
    document.credentials = credentials;
    expectInvalid(document, /credentials/i);
  }
  for (const provider of [null, [], "provider"]) {
    const document = v2Document();
    document.providers = [provider];
    expectInvalid(document, /provider/i);
  }
  for (const models of [undefined, null, {}, [], "model"]) {
    const document = v2Document();
    document.providers[0].models = models;
    expectInvalid(document, /models/i);
  }
  for (const model of [null, [], "model"]) {
    const document = v2Document();
    document.providers[0].models = [model];
    expectInvalid(document, /model/i);
  }

  for (const [field, invalid] of [
    ["id", ""],
    ["id", " unsafe/id "],
    ["name", ""],
    ["name", "   "],
  ]) {
    const document = v2Document();
    document.providers[0][field] = invalid;
    expectInvalid(document, new RegExp(`provider.*${field}`, "i"));
  }
  for (const [field, invalid] of [
    ["alias", ""],
    ["alias", "unsafe alias"],
    ["upstreamModel", ""],
    ["upstreamModel", "   "],
    ["credentialRef", ""],
    ["credentialRef", "   "],
  ]) {
    const document = v2Document();
    document.providers[0].models[0][field] = invalid;
    expectInvalid(document, new RegExp(field, "i"));
  }

  const duplicateProvider = v2Document();
  duplicateProvider.providers.push({ ...clone(duplicateProvider.providers[0]), name: "Provider B" });
  expectInvalid(duplicateProvider, /duplicate provider id/i);

  const duplicateAlias = v2Document();
  duplicateAlias.providers.push({
    id: "provider-b",
    name: "Provider B",
    baseUrl: "https://b.example.com/v1",
    models: [{ alias: "coding-fast", upstreamModel: "different-id", credentialRef: "model-b" }],
  });
  expectInvalid(duplicateAlias, /duplicate model alias/i);

  const missingRef = v2Document();
  missingRef.providers[0].models[0].credentialRef = "missing-descriptor";
  expectInvalid(missingRef, /credential reference/i);

  const nonObjectDescriptor = v2Document();
  nonObjectDescriptor.credentials["model-a"] = "not-an-object";
  expectInvalid(nonObjectDescriptor, /credential descriptor/i);
}

function testUrlValidationAndNormalization() {
  for (const baseUrl of [
    "not a url",
    "ftp://api.example.com/v1",
    "http://api.example.com/v1",
    "http://localhost.example.com/v1",
    "http://127.0.0.1.example.com/v1",
    ["https://fixture-user", String.fromCharCode(58), "fixture-password@api.example.com/v1"].join(""),
    "https://@api.example.com/v1",
    "https://api.example.com/v1#fragment",
    "https://api.example.com/v1#",
  ]) {
    const document = v2Document();
    document.providers[0].baseUrl = baseUrl;
    expectInvalid(document, /baseUrl/i);
  }

  const cases = [
    ["http://localhost:8080/v1/", "http://localhost:8080/v1"],
    ["http://127.12.34.56:8080/root/path///", "http://127.12.34.56:8080/root/path"],
    ["http://[::1]:8080/v1/", "http://[::1]:8080/v1"],
    ["https://api.example.com/shared/path/?region=test", "https://api.example.com/shared/path?region=test"],
  ];
  for (const [baseUrl, expected] of cases) {
    const document = v2Document();
    document.providers[0].baseUrl = baseUrl;
    assert.equal(normalizeConfigDocument(document, "/tmp/url.json").routes[0].baseUrl, expected);
  }

  const v2Query = v2Document();
  v2Query.providers[0].baseUrl = "https://api.example.com/v1/?region=test";
  assert.equal(
    upstreamUrl(normalizeConfigDocument(v2Query, "/tmp/v2-query.json").routes[0]),
    "https://api.example.com/v1/chat/completions?region=test"
  );
  const v1Query = normalizeConfigDocument({
    upstream: {
      baseUrl: "https://api.example.com/v1/?region=test",
      model: "legacy-query",
      apiKeyEnv: "LEGACY_QUERY_KEY",
    },
  }, "/tmp/v1-query.json");
  assert.equal(
    upstreamUrl(v1Query.routes[0]),
    "https://api.example.com/v1/chat/completions?region=test"
  );

  for (const control of ["\t", "\n"]) {
    const v2Control = v2Document();
    v2Control.providers[0].baseUrl = `https://api.example.com/v1${control}?region=test`;
    expectInvalid(v2Control, /baseUrl/i);
    expectInvalid({
      upstream: {
        baseUrl: `https://legacy.example.com/v1${control}?region=test`,
        model: "legacy-control",
        apiKeyEnv: "LEGACY_CONTROL_KEY",
      },
    }, /baseUrl/i);
  }
}

function trappingProxy(target) {
  let trapCount = 0;
  const fail = () => {
    trapCount += 1;
    throw new Error("proxy-trap-secret-must-not-appear");
  };
  return {
    proxy: new Proxy(target, {
      get: fail,
      getPrototypeOf: fail,
      getOwnPropertyDescriptor: fail,
      ownKeys: fail,
    }),
    trapCount: () => trapCount,
  };
}

function assertProxyRejected(invoke, fixture) {
  assert.throws(invoke, (error) => {
    assert.equal(fixture.trapCount(), 0);
    assert.match(error.message, /plain data/i);
    assert.doesNotMatch(error.message, /proxy-trap-secret-must-not-appear/);
    return true;
  });
}

function testProxyObjectsAreRejectedWithoutTraps() {
  let fixture = trappingProxy(v2Document());
  assertProxyRejected(
    () => normalizeConfigDocument(fixture.proxy, "/tmp/root-proxy.json"),
    fixture
  );

  fixture = trappingProxy({});
  assertProxyRejected(
    () => normalizeConfigDocument(v2Document(), "/tmp/options-proxy.json", fixture.proxy),
    fixture
  );

  fixture = trappingProxy({ reliabilityPolicies: {} });
  assertProxyRejected(
    () => normalizeConfigDocument(v2Document(), "/tmp/profile-proxy.json", { profile: fixture.proxy }),
    fixture
  );

  fixture = trappingProxy(v2Document().providers[0]);
  let document = v2Document();
  document.providers[0] = fixture.proxy;
  assertProxyRejected(
    () => normalizeConfigDocument(document, "/tmp/provider-proxy.json"),
    fixture
  );

  fixture = trappingProxy(v2Document().providers[0].models[0]);
  document = v2Document();
  document.providers[0].models[0] = fixture.proxy;
  assertProxyRejected(
    () => normalizeConfigDocument(document, "/tmp/model-proxy.json"),
    fixture
  );

  fixture = trappingProxy(v2Document().credentials["model-a"]);
  document = v2Document();
  document.credentials["model-a"] = fixture.proxy;
  assertProxyRejected(
    () => normalizeConfigDocument(document, "/tmp/credential-proxy.json"),
    fixture
  );

  fixture = trappingProxy(v2Document().providers[0].models[0].capabilities);
  document = v2Document();
  document.providers[0].models[0].capabilities = fixture.proxy;
  assertProxyRejected(
    () => normalizeConfigDocument(document, "/tmp/capability-proxy.json"),
    fixture
  );

  fixture = trappingProxy({ headerTimeoutMs: 700000 });
  document = v2Document();
  document.providers[0].models[0].reliability = fixture.proxy;
  assertProxyRejected(
    () => normalizeConfigDocument(document, "/tmp/reliability-proxy.json"),
    fixture
  );

  fixture = trappingProxy({ path: "/tmp/config.json" });
  assertProxyRejected(
    () => normalizeConfigDocument(v2Document(), fixture.proxy),
    fixture
  );
  for (const configPath of [undefined, null, {}, [], 1, true, Symbol("path")]) {
    assert.throws(() => normalizeConfigDocument(v2Document(), configPath), /configPath/i);
  }
}

function testReferencedCredentialValidation() {
  const validCases = [
    [{ source: "env", env: "VALID_ENV_1" }, { apiKeyEnv: "VALID_ENV_1" }],
    [
      { source: "command", command: { command: "/usr/bin/printf", args: ["synthetic", ""] } },
      { apiKeyCommand: { command: "/usr/bin/printf", args: ["synthetic", ""] } },
    ],
    [{ source: "client" }, { apiKeySource: "client" }],
  ];
  for (const [descriptor, projection] of validCases) {
    const document = v2Document();
    document.credentials["model-a"] = descriptor;
    const route = normalizeConfigDocument(document, "/tmp/credential-valid.json").routes[0];
    for (const [key, value] of Object.entries(projection)) assert.deepEqual(route[key], value);
    assert.equal(Object.isFrozen(route.credential), true);
    if (route.credential.command) assert.equal(Object.isFrozen(route.credential.command.args), true);
  }

  const invalidDescriptors = [
    {},
    { source: "unknown" },
    { source: "env" },
    { source: "env", env: "" },
    { source: "env", env: "1INVALID" },
    { source: "env", env: "INVALID-NAME" },
    { source: "env", env: "VALID_ENV", command: { command: "/usr/bin/printf", args: [] } },
    { source: "env", env: "VALID_ENV", client: true },
    { source: "command", command: "/usr/bin/printf synthetic" },
    { source: "command", command: {} },
    { source: "command", command: { command: "", args: [] } },
    { source: "command", command: { command: "/usr/bin/printf\n", args: [] } },
    { source: "command", command: { command: "/usr/bin/printf", args: "synthetic" } },
    { source: "command", command: { command: "/usr/bin/printf", args: [1] } },
    { source: "command", command: { command: "/usr/bin/printf", args: [], [["sh", "ell"].join("")]: true } },
    { source: "command", command: { command: "/usr/bin/printf", args: [] }, env: "VALID_ENV" },
    { source: "command", command: { command: "/usr/bin/printf", args: [] }, client: true },
    { source: "client", env: "VALID_ENV" },
    { source: "client", command: { command: "/usr/bin/printf", args: [] } },
  ];
  for (const descriptor of invalidDescriptors) {
    const document = v2Document();
    document.credentials["model-a"] = descriptor;
    assert.throws(
      () => normalizeConfigDocument(document, "/tmp/credential-invalid.json"),
      (error) => {
        assert.match(error.message, /credential descriptor/i);
        assert.doesNotMatch(error.message, /VALID_ENV|printf|synthetic/);
        return true;
      }
    );
  }

  const futureDescriptor = v2Document();
  futureDescriptor.credentials["future-model"] = {
    source: "future-source",
    providerData: { nested: ["kept", "frozen"] },
  };
  const normalized = normalizeConfigDocument(futureDescriptor, "/tmp/credential-future.json");
  assert.deepEqual(normalized.credentials["future-model"], futureDescriptor.credentials["future-model"]);
  assert.notEqual(normalized.credentials["future-model"], futureDescriptor.credentials["future-model"]);
  assertFrozenTree(normalized.credentials["future-model"]);
}

function testServerScalarNormalizationAndFreeze() {
  const nested = { retained: false };
  const raw = {
    host: "[::1]",
    port: "0",
    localToken: "local-token",
    heartbeatIntervalMs: "0",
    timeoutMs: "1",
    requestTimeoutMs: "2",
    headersTimeoutMs: "65000",
    keepAliveTimeoutMs: "5000",
    maxBodyBytes: "20971520",
    unknownScalar: "ignored",
    unknownNested: nested,
  };
  const server = normalizeServer(raw);
  assert.deepEqual(server, {
    host: "::1",
    port: 0,
    localToken: "local-token",
    heartbeatIntervalMs: 0,
    timeoutMs: 1,
    requestTimeoutMs: 2,
    headersTimeoutMs: 65000,
    keepAliveTimeoutMs: 5000,
    maxBodyBytes: 20971520,
  });
  assert.equal(Object.isFrozen(server), true);
  assert.equal(Object.hasOwn(server, "unknownScalar"), false);
  assert.equal(Object.hasOwn(server, "unknownNested"), false);
  nested.retained = true;
  assert.equal(Object.hasOwn(server, "unknownNested"), false);
  assert.throws(() => { server.port = 1234; }, TypeError);

  for (const invalid of [
    { host: {} },
    { port: -1 },
    { port: 65536 },
    { localToken: {} },
    { maxBodyBytes: 0 },
  ]) {
    assert.throws(() => normalizeServer(invalid), /server\./i);
  }
}

function testCapabilitiesValidation() {
  const invalidCapabilities = [
    null,
    [],
    { contextWindow: 0 },
    { contextWindow: 1.5 },
    { contextWindow: "131072" },
    { contextWindow: Number.MAX_SAFE_INTEGER + 1 },
    { inputModalities: [] },
    { inputModalities: ["text", "text"] },
    { inputModalities: ["video"] },
    { inputModalities: [1] },
    { reasoning: "true" },
  ];
  for (const capabilities of invalidCapabilities) {
    const document = v2Document();
    document.providers[0].models[0].capabilities = capabilities;
    expectInvalid(document, /capabilit/i);
  }

  const document = v2Document();
  document.providers[0].models[0].capabilities = {
    contextWindow: 1,
    inputModalities: ["audio", "text"],
    reasoning: false,
  };
  assert.deepEqual(normalizeConfigDocument(document, "/tmp/capabilities.json").routes[0].capabilities, {
    contextWindow: 1,
    inputModalities: ["audio", "text"],
    reasoning: false,
  });
}

function testReliabilityValidation() {
  for (const policy of ["", "fast", 1, {}, []]) {
    const document = v2Document();
    document.providers[0].models[0].reliabilityPolicy = policy;
    expectInvalid(document, /reliabilityPolicy/i);
  }
  for (const reliability of [null, [], "stable"]) {
    const document = v2Document();
    document.reliability = reliability;
    expectInvalid(document, /reliability/i);
  }
  for (const [leaf, value] of [
    ["headerTimeoutMs", 0],
    ["headerTimeoutMs", "600000"],
    ["firstDataTimeoutMs", -1],
    ["idleTimeoutMs", 1.5],
    ["nonStreamingTotalTimeoutMs", Number.MAX_SAFE_INTEGER + 1],
    ["streamingTotalTimeoutMs", -1],
    ["downstreamHeartbeatIntervalMs", -1],
  ]) {
    const document = v2Document();
    document.providers[0].models[0].reliability = { [leaf]: value };
    expectInvalid(document, new RegExp(leaf));
  }
  const unknownLeaf = v2Document();
  unknownLeaf.reliability = { timeoutMs: 123 };
  expectInvalid(unknownLeaf, /reliability/i);

  const unknownProfilePolicy = { reliabilityPolicies: { turbo: { headerTimeoutMs: 1 } } };
  expectInvalid(v2Document(), /profile/i, { profile: unknownProfilePolicy });
  const unknownProfileKey = { code: "do-not-run", reliabilityPolicies: {} };
  expectInvalid(v2Document(), /profile/i, { profile: unknownProfileKey });
}

function testDataOnlyAndSafeErrors() {
  let getterCalls = 0;
  const getterDocument = {};
  Object.defineProperty(getterDocument, "version", { enumerable: true, value: 2 });
  Object.defineProperty(getterDocument, "providers", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("credential-value-must-not-appear");
    },
  });
  assert.throws(
    () => normalizeConfigDocument(getterDocument, "/tmp/getter.json"),
    (error) => {
      assert.equal(getterCalls, 0);
      assert.doesNotMatch(error.message, /credential-value-must-not-appear/);
      assert.match(error.message, /plain data/i);
      return true;
    }
  );

  let hiddenGetterCalls = 0;
  const hiddenGetterDocument = v2Document();
  Object.defineProperty(hiddenGetterDocument, "hidden", {
    get() {
      hiddenGetterCalls += 1;
      throw new Error("hidden-secret-must-not-appear");
    },
  });
  assert.throws(
    () => normalizeConfigDocument(hiddenGetterDocument, "/tmp/hidden-getter.json"),
    (error) => {
      assert.equal(hiddenGetterCalls, 0);
      assert.match(error.message, /plain data/i);
      assert.doesNotMatch(error.message, /hidden-secret-must-not-appear/);
      return true;
    }
  );

  const symbolDocument = v2Document();
  symbolDocument[Symbol("hidden")] = "not-json-data";
  expectInvalid(symbolDocument, /plain data/i);

  let executed = false;
  const profile = {
    reliabilityPolicies: {
      stable: {
        headerTimeoutMs() {
          executed = true;
          return 700000;
        },
      },
    },
  };
  expectInvalid(v2Document(), /plain data/i, { profile });
  assert.equal(executed, false);

  let optionsGetterCalls = 0;
  const options = {};
  Object.defineProperty(options, "profile", {
    enumerable: true,
    get() {
      optionsGetterCalls += 1;
      throw new Error("option-secret-must-not-appear");
    },
  });
  assert.throws(
    () => normalizeConfigDocument(v2Document(), "/tmp/options-getter.json", options),
    (error) => {
      assert.equal(optionsGetterCalls, 0);
      assert.doesNotMatch(error.message, /option-secret-must-not-appear/);
      assert.match(error.message, /plain data/i);
      return true;
    }
  );

  const secretDocument = v2Document();
  secretDocument.credentials["model-a"] = {
    source: "env",
    env: "SYNTHETIC_ENV",
    value: "credential-value-must-not-appear",
  };
  secretDocument.providers[0].baseUrl = "malformed-credential-value-must-not-appear";
  assert.throws(
    () => normalizeConfigDocument(secretDocument, "/tmp/secret.json"),
    (error) => {
      assert.doesNotMatch(error.message, /credential-value-must-not-appear/);
      assert.doesNotMatch(error.message, /malformed-/);
      return true;
    }
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-config-v2-invalid-json-"));
  try {
    const invalidPath = path.join(directory, "config.json");
    fs.writeFileSync(invalidPath, '{"credential":"json-secret-must-not-appear",broken}');
    assert.throws(
      () => loadConfig(invalidPath),
      (error) => {
        assert.match(error.message, /not valid JSON/i);
        assert.doesNotMatch(error.message, /json-secret-must-not-appear/);
        assert.doesNotMatch(error.message, /credential/);
        return true;
      }
    );
    const nonObjectPath = path.join(directory, "non-object.json");
    fs.writeFileSync(nonObjectPath, "null\n");
    assert.throws(() => loadConfig(nonObjectPath), /configuration root/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  testVersionTwoNormalization();
  testReliabilityResolutionAndProvenance();
  testVersionOneCompatibility();
  testVersionOneLanAndUnusedListCompatibility();
  testExactVersionTwoResolution();
  testLoadConfigIntegrationAndNoRewrite();
  testShapeAndIdentifierValidation();
  testProxyObjectsAreRejectedWithoutTraps();
  testUrlValidationAndNormalization();
  testReferencedCredentialValidation();
  testServerScalarNormalizationAndFreeze();
  testCapabilitiesValidation();
  testReliabilityValidation();
  testDataOnlyAndSafeErrors();
  console.log("config v2 tests passed");
}

main();
