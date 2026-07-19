# v0.7 Reliability Foundation and Multi-Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider-neutral version 2 model routing, isolated per-model credentials, a safe error type, request state, and redacted events without changing the public protocol behavior.

**Architecture:** Keep `loadConfig()` as the single entry point, normalize version 1 and version 2 files into one runtime route shape, and keep converters unaware of raw configuration. A credential resolver is owned by each loaded config, caches by `credentialRef`, and returns only a key to the transport. Reliability state and events expose allowlisted metadata only.

**Tech Stack:** Node.js 18+ CommonJS, built-in `fs`/`child_process`/`crypto`, `node:assert`, raw Node test scripts, npm.

---

## File Map

- Create `lib/bridge-error.js`: normalized safe error categories and classifier.
- Create `lib/request-state.js`: legal request transitions and semantic-content detection.
- Create `lib/event-store.js`: bounded, redacted, in-memory event ring.
- Create `lib/config-v2.js`: version 1/version 2 validation and normalized route construction.
- Create `lib/credentials.js`: env, command, and client credential resolution and cache invalidation.
- Modify `lib/config.js`: delegate schema normalization and preserve current exports/defaults.
- Modify `lib/server.js`: resolve client aliases and expose aliases in `/v1/models`.
- Modify `lib/upstream.js`: resolve credentials through the config-scoped resolver.
- Modify `lib/request-log.js`: emit the safe event schema to logs and the event store.
- Create `test/bridge-error.test.js`: classifier and redaction table tests.
- Create `test/request-state.test.js`: state transition and semantic boundary tests.
- Create `test/event-store.test.js`: redaction and ring eviction tests.
- Create `test/config-v2.test.js`: compatibility, routing, validation, and credential isolation tests.
- Modify `test/smoke.js`: version 2 aliases and exact upstream model mapping.
- Modify `package.json`: add all new tests to lint and test scripts.

### Task 1: Introduce a safe error taxonomy

**Files:**
- Create: `lib/bridge-error.js`
- Create: `test/bridge-error.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing classifier table**

Cover `AbortError`, `UND_ERR_CONNECT_TIMEOUT`, `ECONNRESET`, DNS/TLS codes,
HTTP 400/401/403/404/408/429/500/503, invalid HTTP 200 protocol data, client
cancellation, and local configuration errors. Assert the serialized result has
only this shape:

```js
assert.deepEqual(JSON.parse(JSON.stringify(classified)), {
  name: "BridgeError",
  category: "rate_limit",
  phase: "waiting_first_content",
  retryable: true,
  scope: "model_route",
  status: 429,
  code: "UPSTREAM_HTTP_429",
  model: "coding-fast",
  requestId: "req-1",
  attempt: 1,
  elapsedMs: 125,
  retryAfterMs: 2000,
});
```

Include a raw error containing an authorization value, prompt, response body,
and nested cause message; assert none appear in serialized output.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/bridge-error.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/bridge-error`.

- [ ] **Step 3: Implement `BridgeError` and the table-driven classifier**

Export `BridgeError`, `classifyError`, `parseRetryAfter`, and
`safeErrorRecord`. Store the raw cause as a non-enumerable property and allow
only category, phase, retryability, scope, numeric status/timing, and validated
safe codes/IDs to serialize. Parse both delta-seconds and HTTP-date
`Retry-After` values and cap later in policy code, not in the classifier.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node test/bridge-error.test.js`

Expected: `bridge error tests passed`.

- [ ] **Step 5: Commit the error foundation**

```bash
git add lib/bridge-error.js test/bridge-error.test.js package.json
git commit -m "feat(reliability): normalize safe bridge errors"
```

### Task 2: Add request state and semantic-content boundaries

**Files:**
- Create: `lib/request-state.js`
- Create: `test/request-state.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing state and content tests**

Assert the only legal flow is `accepted -> connecting ->
waiting_first_content -> streaming -> completed|failed|cancelled`. Test that
heartbeats, `[DONE]`, usage-only chunks, and an empty assistant role do not mark
semantic content. Test non-empty `content`, `reasoning_content`, `reasoning`,
`refusal`, and every non-empty tool-call name/arguments fragment separately.

```js
const state = createRequestState({ requestId: "req-1", model: "coding-fast", now: () => 1000 });
state.transition("connecting");
state.transition("waiting_first_content");
state.observeChatData(JSON.stringify({ choices: [{ delta: { reasoning_content: "plan" } }] }));
assert.equal(state.semanticContentStarted, true);
assert.equal(state.phase, "streaming");
```

Also assert illegal transitions throw a `local_config` `BridgeError` without
including arbitrary caller values.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/request-state.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/request-state`.

- [ ] **Step 3: Implement explicit state transitions and semantic detection**

Use a transition map, monotonic attempt numbers, heartbeat counters, and a
single `observeChatData(data)` method. JSON parse failures are observations,
not state mutations; the stream runner classifies them.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node test/request-state.test.js && node test/bridge-error.test.js`

Expected: both suites print their pass messages.

- [ ] **Step 5: Commit request state**

```bash
git add lib/request-state.js test/request-state.test.js package.json
git commit -m "feat(reliability): track request and semantic stream state"
```

### Task 3: Add a bounded redacted event store

**Files:**
- Create: `lib/event-store.js`
- Create: `test/event-store.test.js`
- Modify: `lib/request-log.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing ring, immutability, and redaction tests**

Create a three-entry store, append five safe events, and assert only sequence
3-5 remain. Mutate both input and returned objects and prove stored events do
not change. Attempt to append `prompt`, `response`, `headers`, `authorization`,
`body`, `reasoning`, and `toolArguments`; assert those keys and values are absent.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/event-store.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/event-store`.

- [ ] **Step 3: Implement the allowlisted event store**

Export `createEventStore({ capacity = 500, now = Date.now })`. Accepted fields
are `sequence`, `timestamp`, `type`, `phase`, `requestId`, `traceId`, `route`,
`model`, `attempt`, `status`, `category`, `code`, `elapsedMs`, `delayMs`,
`heartbeatCount`, and `outcome`. Freeze stored entries and return copies from
`snapshot({ afterSequence, limit })`.

- [ ] **Step 4: Feed request logs and events from one safe record**

Change `logRequestEvent(context, phase, details, eventStore)` to construct one
allowlisted record, append it when a store exists, and print that same record.
Keep all current log redaction tests green.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node test/event-store.test.js && node test/request-log.test.js`

Expected: both suites pass and captured logs contain no supplied secret values.

- [ ] **Step 6: Commit event storage**

```bash
git add lib/event-store.js lib/request-log.js test/event-store.test.js package.json
git commit -m "feat(reliability): record bounded redacted events"
```

### Task 4: Normalize version 1 and version 2 configuration

**Files:**
- Create: `lib/config-v2.js`
- Create: `test/config-v2.test.js`
- Modify: `lib/config.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing compatibility and validation tests**

Use temporary private config files. Assert existing `upstream` and `upstreams`
inputs remain readable and normalize to aliases equal to their model values.
Add version 2 coverage for globally unique aliases, shared `baseUrl`, exact
`upstreamModel`, declared `credentialRef`, optional capabilities, and named
`stable`/`long-thinking` policies. Reject duplicate aliases, duplicate provider
IDs, missing credential references, unsupported versions, non-HTTPS upstreams
except loopback, URL credentials, fragments, and non-object roots.

```js
assert.deepEqual(config.routes.map((route) => ({
  alias: route.alias,
  upstreamModel: route.upstreamModel,
  credentialRef: route.credentialRef,
})), [
  { alias: "coding-fast", upstreamModel: "provider-model-id-a", credentialRef: "model-a" },
  { alias: "coding-strong", upstreamModel: "provider-model-id-b", credentialRef: "model-b" },
]);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/config-v2.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/config-v2`.

- [ ] **Step 3: Implement pure normalization**

Export `normalizeConfigDocument(document, configPath)`. Produce frozen routes
with `alias`, `upstreamModel`, backward-compatible `model`, `providerId`,
`providerName`, `baseUrl`, `credentialRef`, `credential`, `capabilities`, and
resolved reliability values. Preserve `config.upstreams` as an alias to routes
for internal 0.6 compatibility, but make `resolveUpstream(config, model)` match
only `route.alias` for multi-route configurations.

- [ ] **Step 4: Make effective values provenance-aware**

For each reliability leaf, retain `{ value, source }` internally where source
is `built_in`, `profile`, or `user`; runtime routes receive plain values while
`config.effective` keeps the annotated form for the later CLI command.

- [ ] **Step 5: Run focused and current config tests and verify GREEN**

Run: `node test/config-v2.test.js && node test/security-files.test.js && node test/smoke.js`

Expected: version 1 tests continue passing and the new validation suite passes.

- [ ] **Step 6: Commit version 2 normalization**

```bash
git add lib/config-v2.js lib/config.js test/config-v2.test.js package.json
git commit -m "feat(config): add version 2 model routes"
```

### Task 5: Isolate credentials by reference and route aliases correctly

**Files:**
- Create: `lib/credentials.js`
- Modify: `lib/config.js`
- Modify: `lib/upstream.js`
- Modify: `lib/server.js`
- Modify: `test/config-v2.test.js`
- Modify: `test/smoke.js`

- [ ] **Step 1: Add failing credential isolation tests**

Use one fake endpoint with two aliases and two exact model IDs. Credential
commands increment separate counters. Assert each request has the correct model
and bearer value, cache hits do not rerun commands, invalidating `model-a` does
not rerun `model-b`, command execution uses an argv array without a shell, and
client credentials are never cached.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node test/config-v2.test.js`

Expected: failures show the existing cache is keyed by route object and the
server exposes upstream IDs instead of client aliases.

- [ ] **Step 3: Implement a config-scoped credential resolver**

Export `createCredentialResolver(descriptors, options)` with
`resolve(credentialRef, { clientApiKey })`, `invalidate(credentialRef)`, and
`availability(credentialRef)`. Use `spawnSync(command, args, { encoding:
"utf8", timeout: 10000, windowsHide: true })`; reject shell strings in version
2, cap command stdout at 64 KiB, trim the token, and never include it in errors.

- [ ] **Step 4: Route client aliases while sending exact upstream IDs**

Change `/v1/models` to publish `route.alias`, request lookup to match aliases,
and converter input to rewrite `payload.model` to `route.upstreamModel`. The
heartbeat and client-facing metadata use the alias; outbound JSON uses the
exact upstream ID.

- [ ] **Step 5: Run the full foundation suite**

Run: `npm test`

Expected: all existing and newly registered tests pass.

- [ ] **Step 6: Run initial security checks**

Run: `npm run lint && npm run security:scan && npm run secretlint`

Expected: syntax, static security, and secret scanning all pass.

- [ ] **Step 7: Commit credential and route integration**

```bash
git add lib/credentials.js lib/config.js lib/upstream.js lib/server.js test/config-v2.test.js test/smoke.js
git commit -m "feat(routing): isolate model credentials by reference"
```

## Plan Acceptance

- [ ] Version 1 config files behave as they did in 0.6.3.
- [ ] Every version 2 alias maps to one exact upstream model ID and credential reference.
- [ ] Invalidating one credential cannot evict another model's cached credential.
- [ ] Errors and events serialize no prompt, response, header, body, reasoning, tool argument, or key.
- [ ] `/v1/models` exposes client aliases while upstream requests use exact provider model IDs.
- [ ] `npm test`, lint, security scan, and secret scan pass at the final commit.
