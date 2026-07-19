# v0.7 Pre-Content Retry and Cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover retryable same-model failures before semantic output, never replay after semantic output, and isolate timeout/backoff/cooldown state per model route.

**Architecture:** A policy module makes deterministic retry decisions, a route-health registry owns circuit state, and one attempt runner wraps the upstream chat protocol used by all downstream converters. The downstream heartbeat remains active across attempts and waits. Converters receive attempt events but retain ownership of protocol translation.

**Tech Stack:** Node.js 18+ CommonJS, built-in `fetch`/Web Streams/`AbortController`, deterministic injected clock/random functions, `node:assert`.

---

## File Map

- Create `lib/retry-policy.js`: retry decisions, full-jitter backoff, and budgets.
- Create `lib/route-health.js`: per-route closed/open/half-open state.
- Create `lib/phase-timeout.js`: connection, first-data, idle, and non-stream deadlines.
- Create `lib/attempt-runner.js`: bounded upstream attempts and semantic no-replay enforcement.
- Modify `lib/upstream.js`: expose response/status/body reads under phase deadlines.
- Modify `lib/heartbeat.js`: event hook and injected clock support.
- Modify `lib/converters/chat.js`: use the attempt runner and preserve transport-reset semantics.
- Modify `lib/converters/responses.js`: use retrying chat events for streaming/non-streaming conversion.
- Modify `lib/converters/anthropic.js`: retry the buffered upstream call before downstream semantic output.
- Modify `lib/server.js`: create shared health/event runtime and request state.
- Create `test/retry-policy.test.js`: decision and deterministic backoff tables.
- Create `test/route-health.test.js`: isolation, cooldown, and half-open tests.
- Create `test/phase-timeout.test.js`: deadline reset and cancellation tests.
- Create `test/pre-content-retry.test.js`: multi-protocol fault integration tests.
- Modify `test/streaming-keepalive.test.js`: heartbeat-during-retry assertions.
- Modify `package.json`: register tests and recursive syntax checks for new files.

### Task 1: Implement deterministic retry policy and budgets

**Files:**
- Create: `lib/retry-policy.js`
- Create: `test/retry-policy.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing retry matrix**

Table-test every category before and after semantic content. Assert defaults are
three total attempts, 500 ms base delay, 10-second single-delay cap, 30-second
cumulative cap, and 120-second accepted `Retry-After` cap. Assert 400/403/404,
cancelled, and local config never retry; 401 refreshes its credential once only.

```js
assert.deepEqual(decideRetry({
  error: new BridgeError({ category: "network", retryable: true }),
  attempt: 1,
  semanticContentStarted: false,
  cumulativeDelayMs: 0,
  policy: stablePolicy,
  random: () => 0.5,
}), { retry: true, delayMs: 250, refreshCredential: false, reason: "retryable_pre_content" });
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/retry-policy.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/retry-policy`.

- [ ] **Step 3: Implement full-jitter decisions**

Calculate `rawCap = min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))` and
`delayMs = floor(random() * (rawCap + 1))`. A valid `Retry-After` replaces the
jitter value only when it fits both its own cap and the remaining cumulative
budget. Return a structured no-retry reason for event logging.

- [ ] **Step 4: Run the focused suite and commit**

Run: `node test/retry-policy.test.js`

Expected: `retry policy tests passed`.

```bash
git add lib/retry-policy.js test/retry-policy.test.js package.json
git commit -m "feat(reliability): add bounded retry policy"
```

### Task 2: Add isolated route cooldown and half-open probes

**Files:**
- Create: `lib/route-health.js`
- Create: `test/route-health.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing per-route health tests**

Use two aliases sharing a base URL. Five retryable terminal failures on
`coding-fast` must open it for 30 seconds while `coding-strong` stays closed.
At expiry, allow exactly one half-open probe; reject concurrent probes. Success
closes and clears failures; failure reopens. Apply an upstream retry-after value
but cap route cooldown at 120 seconds. A request may wait for cooldown only when
the delay fits its remaining cumulative wait budget; otherwise it fails with
retryable transport semantics. In neither case may it fail over to another alias.

- [ ] **Step 2: Run the test and verify RED**

Run: `node test/route-health.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/route-health`.

- [ ] **Step 3: Implement `createRouteHealthRegistry()`**

Key entries by globally unique alias. Export `acquire(alias, now)`,
`recordSuccess(alias)`, `recordTerminalFailure(alias, error, now)`,
`releaseProbe(alias)`, and `snapshot(now)`. Return immutable decisions and never
store credentials or raw errors.

- [ ] **Step 4: Run focused tests and commit**

Run: `node test/route-health.test.js && node test/retry-policy.test.js`

Expected: both suites pass.

```bash
git add lib/route-health.js test/route-health.test.js package.json
git commit -m "feat(reliability): isolate route cooldown state"
```

### Task 3: Replace one total timeout with phase-aware deadlines

**Files:**
- Create: `lib/phase-timeout.js`
- Create: `test/phase-timeout.test.js`
- Modify: `lib/upstream.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing deadline tests with a fake clock**

Cover headers timeout, first data timeout, idle timeout reset after every real
chunk, total non-stream timeout, disabled total stream timeout, upstream abort,
and client cancellation. Assert stable uses ten minutes for header/first/idle
and long-thinking uses thirty minutes for header/first while both retain no
total streaming deadline.

- [ ] **Step 2: Run the test and verify RED**

Run: `node test/phase-timeout.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/phase-timeout`.

- [ ] **Step 3: Implement one replaceable timer per attempt**

Export `createPhaseDeadline({ controller, policy, streaming, timers })` with
`waitingForHeaders()`, `headersReceived()`, `dataReceived()`, `completed()`, and
`cancelled()`. Each timeout aborts with a safe code identifying its phase. Do
not retain a ten-minute total timer after streaming headers arrive.

- [ ] **Step 4: Refactor `fetchUpstream()` around phase notifications**

Keep response-size and SSE-event limits. Return a wrapped response whose body
calls `dataReceived()` for each non-empty byte chunk. Make body completion clear
the deadline and external signal listener. A 401 no longer invalidates a global
cache here; the attempt runner performs one scoped refresh decision.

- [ ] **Step 5: Run transport/security tests and commit**

Run: `node test/phase-timeout.test.js && node test/security-http.test.js && node test/streaming-keepalive.test.js`

Expected: all suites pass without dangling timers.

```bash
git add lib/phase-timeout.js lib/upstream.js test/phase-timeout.test.js package.json
git commit -m "feat(reliability): enforce phase-aware upstream deadlines"
```

### Task 4: Implement the bounded upstream attempt runner

**Files:**
- Create: `lib/attempt-runner.js`
- Create: `test/pre-content-retry.test.js`
- Modify: `lib/heartbeat.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing fake-upstream recovery tests**

Use one server whose scripted attempts return, independently: connection reset,
slow headers, slow first data, idle timeout, 408, 429 plus `Retry-After`, 500,
503, 401 then credential rotation, invalid HTTP 200 JSON, valid non-SSE JSON,
and success. Assert retry counts, exact alias/model/key, attempt event timing,
and cancellation of the failed body before the next attempt.

- [ ] **Step 2: Write failing no-replay tests**

For text, reasoning, refusal, tool-call name, and fragmented tool arguments,
send one semantic delta then reset the socket. Assert the fake upstream sees
exactly one request, the downstream transport fails, and no terminal success
frame is emitted. Repeat with heartbeat/start/usage/empty-role events and assert
a pre-content retry is allowed.

- [ ] **Step 3: Run the focused test and verify RED**

Run: `node test/pre-content-retry.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/attempt-runner`.

- [ ] **Step 4: Implement `runChatAttempts()`**

Accept `{ route, payload, requestState, credentialResolver, healthRegistry,
policy, signal, eventStore, onHeaders, onData, onJsonCompletion, wait, random }`.
Keep one stable request ID, increment child attempts, classify every failure,
cancel failed streams, apply scoped 401 refresh once, wait with abort support,
and consult health before each attempt. Invoke `onData` only with parsed SSE data
and mark semantic state before it reaches the converter.

- [ ] **Step 5: Keep the protocol heartbeat alive across every wait**

Add an optional `onHeartbeat` callback to `startHeartbeat()`. The converter
starts one downstream heartbeat before calling the runner and stops it only on
completion/cancellation/final failure. Retries, backoff, and cooldown must not
stop or recreate the heartbeat.

- [ ] **Step 6: Run focused tests and commit**

Run: `node test/pre-content-retry.test.js && node test/streaming-keepalive.test.js`

Expected: all fault scripts recover before semantic output and never replay
after semantic output.

```bash
git add lib/attempt-runner.js lib/heartbeat.js test/pre-content-retry.test.js test/streaming-keepalive.test.js package.json
git commit -m "feat(reliability): retry only before semantic output"
```

### Task 5: Integrate retries across Chat, Responses, and Anthropic routes

**Files:**
- Modify: `lib/converters/chat.js`
- Modify: `lib/converters/responses.js`
- Modify: `lib/converters/anthropic.js`
- Modify: `lib/server.js`
- Modify: `test/pre-content-retry.test.js`
- Modify: `test/smoke.js`

- [ ] **Step 1: Add failing protocol integration assertions**

For each downstream protocol, inject two pre-content failures followed by
success. Assert Chat receives valid chunks and `[DONE]`, Responses receives one
valid response event sequence, and Anthropic receives one valid message event
sequence. Exhaust retries before semantic output and assert committed streams
reset; uncommitted non-stream requests retain meaningful safe HTTP status.

- [ ] **Step 2: Create one reliability runtime per server**

In `startServer`, create the route-health registry and event store once. Create
one request state per API request and pass `{ requestState, healthRegistry,
eventStore, credentialResolver }` into converters. Do not use module-global
health, credential, or request state.

- [ ] **Step 3: Convert protocol handlers to the shared runner**

Chat writes each accepted upstream data event as Chat SSE. Responses transforms
the same accepted events with its existing converter. Anthropic retries its
buffered non-stream chat completion, then begins semantic message blocks once.
All three destroy a committed downstream stream on final retryable failure.

- [ ] **Step 4: Verify cancellation and graceful shutdown**

Assert client close aborts the active attempt and pending wait immediately, and
SIGTERM ends downstream streams without starting a retry. Existing stream
registration behavior must remain green.

- [ ] **Step 5: Run the complete suite and security checks**

Run: `npm test && npm run lint && npm run security:scan && npm run secretlint`

Expected: all commands exit 0.

- [ ] **Step 6: Commit protocol integration**

```bash
git add lib/converters/chat.js lib/converters/responses.js lib/converters/anthropic.js lib/server.js test/pre-content-retry.test.js test/smoke.js
git commit -m "feat(reliability): recover pre-content failures across protocols"
```

## Plan Acceptance

- [ ] All retry decisions are deterministic under injected clock/random functions.
- [ ] Heartbeats remain active during attempts, backoff, and eligible cooldown waits.
- [ ] 401 reloads only the current model credential once.
- [ ] Health and half-open probes are isolated by client alias.
- [ ] Text, reasoning, refusal, and tool-call deltas permanently disable bridge replay.
- [ ] No total streaming deadline cuts off an otherwise active long response.
- [ ] The complete existing suite and all new reliability tests pass.
