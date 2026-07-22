#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeConfigDocument } = require("../lib/config-v2");
const { createCredentialResolver } = require("../lib/credentials");
const { startServer } = require("../lib/server");
const { startFakeMultiModel } = require("../test/helpers/fake-multimodel-upstream");

const ROUTES = [
  { alias: "coding-fast", model: "provider-model-id-a", env: "SOAK_FAST_KEY" },
  { alias: "coding-strong", model: "provider-model-id-b", env: "SOAK_STRONG_KEY" },
  { alias: "coding-long", model: "provider-model-id-c", env: "SOAK_LONG_KEY" },
];
const FAULT_NAMES = [
  "slow_first_content",
  "midstream_gap",
  "non_sse_success",
  "invalid_json",
  "reset_before_content",
  "http_408",
  "http_429",
  "http_503",
  "credential_rotation",
  "two_consecutive_failures",
  "reset_after_semantic",
];
const WEIGHTED_FAULTS = [
  "slow_first_content",
  "midstream_gap",
  "non_sse_success",
  "non_sse_success",
  "invalid_json",
  "reset_before_content",
  "http_408",
  "http_429",
  "http_503",
  "credential_rotation",
  "two_consecutive_failures",
  "reset_after_semantic",
];

function parsePositiveInteger(value, name) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function parseArgs(argv) {
  const options = { durationMs: 1_200_000, seed: 7070, reportPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--duration-ms") options.durationMs = parsePositiveInteger(value, name);
    else if (name === "--seed") options.seed = parsePositiveInteger(value, name);
    else if (name === "--report") {
      if (typeof value !== "string" || !value) throw new Error("--report requires a path.");
      options.reportPath = path.resolve(value);
    } else throw new Error(`Unknown argument: ${name}`);
    index += 1;
  }
  return options;
}

function seededRandom(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function testKey(seed, alias, revision = 0) {
  return `soak-${crypto.createHash("sha256").update(`${seed}:${alias}:${revision}`).digest("hex")}`;
}

function configuration(baseUrl, durationMs) {
  const shortMode = durationMs < 60_000;
  return {
    version: 2,
    reliability: {
      headerTimeoutMs: shortMode ? 500 : 10_000,
      firstDataTimeoutMs: shortMode ? 500 : 10_000,
      idleTimeoutMs: shortMode ? 500 : 30_000,
      nonStreamingTotalTimeoutMs: shortMode ? 1500 : 30_000,
      streamingTotalTimeoutMs: shortMode ? 2500 : 60_000,
      downstreamHeartbeatIntervalMs: shortMode ? 10 : 5000,
    },
    providers: [{
      id: "soak-provider",
      name: "Soak Provider",
      baseUrl,
      models: ROUTES.map((route) => ({
        alias: route.alias,
        upstreamModel: route.model,
        credentialRef: `${route.alias}-credential`,
      })),
    }],
    credentials: Object.fromEntries(ROUTES.map((route) => [
      `${route.alias}-credential`,
      { source: "env", env: route.env },
    ])),
  };
}

function countOccurrences(text, value) {
  if (!value) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(value, offset)) >= 0) {
    count += 1;
    offset += value.length;
  }
  return count;
}

async function readTimedBody(response, metrics) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let lastChunkAt = Date.now();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const now = Date.now();
    metrics.maxHeartbeatGapMs = Math.max(metrics.maxHeartbeatGapMs, now - lastChunkAt);
    lastChunkAt = now;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function expectedStep(fault, marker, timings) {
  if (fault === "slow_first_content") return [{ type: "slow_first", delayMs: timings.slowFirstMs, content: marker }];
  if (fault === "midstream_gap") return [{ type: "idle_gap", delayMs: timings.midstreamGapMs, content: marker }];
  if (fault === "non_sse_success") return [{ type: "json", content: marker }];
  if (fault === "invalid_json") return [{ type: "invalid_json" }, { type: "json", content: marker }];
  if (fault === "reset_before_content") return [{ type: "reset" }, { type: "sse", content: marker }];
  if (fault === "http_408") return [{ type: "status", status: 408, retryAfter: "0" }, { type: "json", content: marker }];
  if (fault === "http_429") return [{ type: "status", status: 429, retryAfter: "0" }, { type: "json", content: marker }];
  if (fault === "http_503") return [{ type: "status", status: 503 }, { type: "json", content: marker }];
  if (fault === "credential_rotation") return [{ type: "json", content: marker }];
  if (fault === "two_consecutive_failures") {
    return [
      { type: "status", status: 408, retryAfter: "0" },
      { type: "status", status: 503 },
      { type: "json", content: marker },
    ];
  }
  if (fault === "reset_after_semantic") return [{ type: "reset_after_content", content: marker }];
  throw new Error(`Unknown fault: ${fault}`);
}

function emptyReport(durationMs, seed) {
  return {
    schemaVersion: 1,
    ok: false,
    seed,
    requestedDurationMs: durationMs,
    actualDurationMs: 0,
    routes: Object.fromEntries(ROUTES.map((route) => [route.alias, {
      requests: 0,
      successes: 0,
      recoveries: 0,
      failures: 0,
    }])),
    faults: Object.fromEntries(FAULT_NAMES.map((name) => [name, 0])),
    metrics: {
      maxAttempt: 0,
      maxBackoffMs: 0,
      maxHeartbeatGapMs: 0,
      leakedHandleTypes: [],
    },
    violations: {
      semanticReplayCount: 0,
      leakedSecretCount: 0,
      aliasModelKeyMismatchCount: 0,
      eventRingOverflowCount: 0,
      cooldownSuccessCount: 0,
      missingHeartbeatCount: 0,
      leakedHandleCount: 0,
      unexplainedTerminalFailureCount: 0,
    },
    processErrors: {
      unhandledRejectionCount: 0,
      uncaughtExceptionCount: 0,
    },
  };
}

function inspectEvents(events, report) {
  for (const event of events) {
    if (event.type === "attempt_start") report.metrics.maxAttempt = Math.max(report.metrics.maxAttempt, event.attempt || 0);
    if (event.type === "retry_scheduled" || event.type === "cooldown_wait") {
      report.metrics.maxBackoffMs = Math.max(report.metrics.maxBackoffMs, event.delayMs || 0);
    }
  }
  if (events.length > 500) report.violations.eventRingOverflowCount += 1;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].sequence <= events[index - 1].sequence) report.violations.eventRingOverflowCount += 1;
  }
}

function writeReport(reportPath, report) {
  if (!reportPath) return;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

async function runSoak(options) {
  const report = emptyReport(options.durationMs, options.seed);
  const startedAt = Date.now();
  const shortMode = options.durationMs < 60_000;
  const timings = {
    slowFirstMs: shortMode ? 30 : 2000,
    midstreamGapMs: shortMode ? 45 : 20_000,
    heartbeatMs: shortMode ? 10 : 5000,
  };
  const random = seededRandom(options.seed);
  const previousRandom = Math.random;
  const originalConsoleError = console.error;
  const capturedLogs = [];
  const keyRevisions = new Map(ROUTES.map((route) => [route.alias, 0]));
  const keys = new Map(ROUTES.map((route) => [route.alias, testKey(options.seed, route.alias)]));
  const env = Object.fromEntries(ROUTES.map((route) => [route.env, keys.get(route.alias)]));
  const baselineHandles = new Set(process._getActiveHandles());
  const baselineSignals = {
    SIGINT: new Set(process.listeners("SIGINT")),
    SIGTERM: new Set(process.listeners("SIGTERM")),
  };
  const onUnhandledRejection = () => { report.processErrors.unhandledRejectionCount += 1; };
  const onUncaughtException = () => { report.processErrors.uncaughtExceptionCount += 1; };
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  Math.random = random;
  console.error = (...args) => capturedLogs.push(args.map(String).join(" "));

  let fake;
  let bridge;
  let lastSequence = 0;
  let scenarioNumber = 0;
  try {
    fake = await startFakeMultiModel({
      routes: ROUTES.map((route) => ({ alias: route.alias, model: route.model, key: keys.get(route.alias) })),
      scripts: {},
    });
    const normalized = normalizeConfigDocument(configuration(fake.baseUrl, options.durationMs), "/tmp/fault-soak.json");
    const credentialResolver = createCredentialResolver(normalized.credentials, { env, ttlMs: 60_000 });
    const localToken = testKey(options.seed, "local");
    bridge = startServer({
      ...normalized,
      server: {
        host: "127.0.0.1",
        port: 0,
        localToken,
        heartbeatIntervalMs: timings.heartbeatMs,
      },
      credentialResolver,
    });
    if (!bridge.listening) await new Promise((resolve) => bridge.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${bridge.address().port}`;
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${localToken}` };

    async function runScenario(fault, alias) {
      scenarioNumber += 1;
      report.faults[fault] += 1;
      report.routes[alias].requests += 1;
      const route = ROUTES.find((candidate) => candidate.alias === alias);
      const marker = `soak-output-${scenarioNumber}`;
      const stream = ["slow_first_content", "midstream_gap", "reset_before_content", "reset_after_semantic"].includes(fault);
      const expectedDisconnect = fault === "reset_after_semantic";
      let allowedAuthMismatches = 0;
      if (fault === "credential_rotation") {
        const revision = keyRevisions.get(alias) + 1;
        keyRevisions.set(alias, revision);
        const nextKey = testKey(options.seed, alias, revision);
        keys.set(alias, nextKey);
        env[route.env] = nextKey;
        fake.rotateKey(alias, nextKey);
        allowedAuthMismatches = 1;
      }
      fake.setScript(alias, expectedStep(fault, marker, timings));
      const before = fake.requestsFor(alias).length;
      let responseText = "";
      let expectedFailureObserved = false;
      try {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: alias,
            messages: [{ role: "user", content: "soak probe" }],
            stream,
          }),
        });
        try {
          responseText = await readTimedBody(response, report.metrics);
        } catch {
          expectedFailureObserved = expectedDisconnect;
        }
        if (!expectedDisconnect && (response.status !== 200 || !responseText.includes(marker))) {
          report.routes[alias].failures += 1;
          report.violations.unexplainedTerminalFailureCount += 1;
        } else if (expectedDisconnect && !expectedFailureObserved) {
          report.routes[alias].failures += 1;
          report.violations.unexplainedTerminalFailureCount += 1;
        } else {
          report.routes[alias].successes += 1;
        }
      } catch {
        if (expectedDisconnect) {
          expectedFailureObserved = true;
          report.routes[alias].successes += 1;
        } else {
          report.routes[alias].failures += 1;
          report.violations.unexplainedTerminalFailureCount += 1;
        }
      }

      const records = fake.requestsFor(alias).slice(before);
      if (records.length > 1) report.routes[alias].recoveries += 1;
      const authMismatches = records.filter((record) => !record.authorizationMatched).length;
      if (authMismatches !== allowedAuthMismatches || records.some((record) => record.model !== route.model)) {
        report.violations.aliasModelKeyMismatchCount += 1;
      }
      if (expectedDisconnect && records.length !== 1) report.violations.semanticReplayCount += 1;
      if (!expectedDisconnect && countOccurrences(responseText, marker) !== 1) report.violations.semanticReplayCount += 1;

      for (const key of keys.values()) {
        if (responseText.includes(key)) report.violations.leakedSecretCount += 1;
      }
      if (ROUTES.some((candidate) => responseText.includes(candidate.model))) {
        report.violations.aliasModelKeyMismatchCount += 1;
      }

      const events = bridge.bridgeRuntime.eventStore.snapshot({ afterSequence: lastSequence, limit: 500 });
      inspectEvents(events, report);
      if (events.length) lastSequence = events.at(-1).sequence;
      if (["slow_first_content", "midstream_gap"].includes(fault) &&
        report.metrics.maxHeartbeatGapMs > (2 * timings.heartbeatMs) + 500) {
        report.violations.missingHeartbeatCount += 1;
      }
    }

    for (let index = 0; index < FAULT_NAMES.length; index += 1) {
      await runScenario(FAULT_NAMES[index], ROUTES[index % ROUTES.length].alias);
    }
    while (Date.now() - startedAt < options.durationMs) {
      const fault = WEIGHTED_FAULTS[Math.floor(random() * WEIGHTED_FAULTS.length)];
      const alias = ROUTES[Math.floor(random() * ROUTES.length)].alias;
      await runScenario(fault, alias);
    }

    const logText = capturedLogs.join("\n");
    for (const key of keys.values()) {
      if (logText.includes(key)) report.violations.leakedSecretCount += 1;
    }
    if (ROUTES.some((route) => logText.includes(route.model))) {
      report.violations.aliasModelKeyMismatchCount += 1;
    }
    const eventSnapshot = bridge.bridgeRuntime.eventStore.snapshot();
    if (eventSnapshot.length > 500) report.violations.eventRingOverflowCount += 1;
  } finally {
    await closeServer(bridge);
    await fake?.close();
    for (const signal of ["SIGINT", "SIGTERM"]) {
      for (const listener of process.listeners(signal)) {
        if (!baselineSignals[signal].has(listener)) process.removeListener(signal, listener);
      }
    }
    console.error = originalConsoleError;
    Math.random = previousRandom;
    process.removeListener("unhandledRejection", onUnhandledRejection);
    process.removeListener("uncaughtException", onUncaughtException);
    await new Promise((resolve) => setImmediate(resolve));
    const extraHandles = process._getActiveHandles().filter((handle) => (
      !baselineHandles.has(handle)
      && handle !== process.stdin
      && handle !== process.stdout
      && handle !== process.stderr
      && !(handle?.constructor?.name === "Server" && handle.listening === false)
      && handle.destroyed !== true
      && (typeof handle.hasRef !== "function" || handle.hasRef())
    ));
    report.violations.leakedHandleCount = extraHandles.length;
    report.metrics.leakedHandleTypes = extraHandles.map((handle) => handle?.constructor?.name || "Unknown").sort();
    report.actualDurationMs = Date.now() - startedAt;
  }

  const violations = Object.values(report.violations).reduce((sum, count) => sum + count, 0);
  const processErrors = Object.values(report.processErrors).reduce((sum, count) => sum + count, 0);
  const completeCoverage = Object.values(report.faults).every((count) => count > 0)
    && Object.values(report.routes).every((route) => route.successes > 0 && route.recoveries > 0);
  report.ok = violations === 0 && processErrors === 0 && completeCoverage && report.actualDurationMs >= options.durationMs;
  return report;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.reportPath) fs.rmSync(options.reportPath, { force: true });
    const report = await runSoak(options);
    writeReport(options.reportPath, report);
    console.log(`fault soak ${report.ok ? "passed" : "failed"}: duration=${report.actualDurationMs}ms seed=${report.seed}`);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    if (options?.reportPath) {
      writeReport(options.reportPath, {
        schemaVersion: 1,
        ok: false,
        seed: options.seed,
        requestedDurationMs: options.durationMs,
        error: "fault_soak_failed",
      });
    }
    console.error(error.stack || String(error));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs, runSoak };
