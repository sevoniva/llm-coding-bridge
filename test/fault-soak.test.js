"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-fault-soak-test-"));
const reportPath = path.join(directory, "report.json");

async function main() {
try {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "..", "scripts", "fault-soak.js"),
    "--duration-ms", "3000",
    "--seed", "7070",
    "--report", reportPath,
  ], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(reportPath), true);

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.ok, true);
  assert.equal(report.seed, 7070);
  assert.equal(report.requestedDurationMs, 3000);
  assert.ok(report.actualDurationMs >= 3000, report.actualDurationMs);

  const aliases = ["coding-fast", "coding-strong", "coding-long"];
  assert.deepEqual(Object.keys(report.routes), aliases);
  for (const alias of aliases) {
    const counters = report.routes[alias];
    for (const field of ["requests", "successes", "recoveries", "failures"]) {
      assert.equal(Number.isSafeInteger(counters[field]) && counters[field] >= 0, true, `${alias}.${field}`);
    }
    assert.ok(counters.requests > 0, alias);
    assert.ok(counters.successes > 0, alias);
    assert.ok(counters.recoveries > 0, alias);
    assert.equal(counters.failures, 0, alias);
  }

  const faultNames = [
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
  assert.deepEqual(Object.keys(report.faults), faultNames);
  for (const name of faultNames) assert.ok(report.faults[name] > 0, name);

  for (const field of ["maxAttempt", "maxBackoffMs", "maxHeartbeatGapMs"]) {
    assert.equal(Number.isSafeInteger(report.metrics[field]) && report.metrics[field] >= 0, true, field);
  }
  assert.ok(report.metrics.maxAttempt >= 2);
  assert.ok(report.metrics.maxHeartbeatGapMs > 0);

  assert.deepEqual(report.violations, {
    semanticReplayCount: 0,
    leakedSecretCount: 0,
    aliasModelKeyMismatchCount: 0,
    eventRingOverflowCount: 0,
    cooldownSuccessCount: 0,
    missingHeartbeatCount: 0,
    leakedHandleCount: 0,
    unexplainedTerminalFailureCount: 0,
  });
  assert.deepEqual(report.processErrors, {
    unhandledRejectionCount: 0,
    uncaughtExceptionCount: 0,
  });

  fs.writeFileSync(reportPath, "stale successful report\n");
  const interrupted = spawn(process.execPath, [
    path.join(__dirname, "..", "scripts", "fault-soak.js"),
    "--duration-ms", "60000",
    "--seed", "7070",
    "--report", reportPath,
  ], {
    cwd: path.join(__dirname, ".."),
    stdio: "ignore",
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  interrupted.kill("SIGTERM");
  await new Promise((resolve) => interrupted.once("close", resolve));
  assert.equal(fs.existsSync(reportPath), false, "an interrupted soak must not leave a stale report");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
  console.log("fault soak tests passed");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
