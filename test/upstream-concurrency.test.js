"use strict";

const assert = require("node:assert/strict");
const {
  createUpstreamConcurrencyRegistry,
  createUpstreamPacingRegistry,
} = require("../lib/upstream-concurrency");

async function main() {
  const registry = createUpstreamConcurrencyRegistry();
  const first = await registry.acquire("finna", 1);
  const order = [];
  const secondPromise = registry.acquire("finna", 1).then((lease) => {
    order.push("second");
    return lease;
  });
  const thirdPromise = registry.acquire("finna", 1).then((lease) => {
    order.push("third");
    return lease;
  });

  await Promise.resolve();
  assert.deepEqual(order, []);
  first.release();
  const second = await secondPromise;
  assert.deepEqual(order, ["second"]);
  second.release();
  const third = await thirdPromise;
  assert.deepEqual(order, ["second", "third"]);
  third.release();

  const occupied = await registry.acquire("cancelled", 1);
  const controller = new AbortController();
  const cancelled = registry.acquire("cancelled", 1, controller.signal);
  controller.abort();
  await assert.rejects(cancelled, (error) => error.name === "AbortError");
  occupied.release();
  const afterCancellation = await registry.acquire("cancelled", 1);
  afterCancellation.release();

  const unlimited = await registry.acquire("unlimited", 0);
  assert.equal(unlimited.queued, false);
  unlimited.release();

  let currentTime = 1_000;
  const waits = [];
  const pacing = createUpstreamPacingRegistry({
    now: () => currentTime,
    wait: async (delayMs) => {
      waits.push(delayMs);
      currentTime += delayMs;
    },
  });
  assert.equal((await pacing.wait("finna", 7_000)).delayMs, 0);
  assert.equal((await pacing.wait("finna", 7_000)).delayMs, 7_000);
  assert.equal((await pacing.wait("finna", 7_000)).delayMs, 7_000);
  assert.deepEqual(waits, [7_000, 7_000]);

  console.log("upstream concurrency tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
