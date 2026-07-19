# ZCode Stream Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ZCode long streams survive awake-time upstream gaps and continue its normal retry sequence after sleep/wake transport failures.

**Architecture:** Keep the existing bridge routes and converters. Extend the generic heartbeat with a request-specific frame plus idle `touch()`, use a protocol-valid empty OpenAI chat chunk throughout the chat stream, expose pre-response transport failures as connection failures, and add a small allowlisted diagnostic logger.

**Tech Stack:** Node.js 18+ CommonJS, built-in `http`/`fetch`/Web Streams, `node:assert`, launchd, npm.

---

## File Map

- `lib/heartbeat.js`: generic idle heartbeat lifecycle and `touch()` API.
- `lib/upstream.js`: notify callers whenever a real upstream byte chunk arrives.
- `lib/converters/chat.js`: OpenAI chat heartbeat frame and retryable transport semantics.
- `lib/request-log.js`: allowlisted request context and one-line redacted diagnostics.
- `lib/server.js`: create request context from safe ZCode headers and pass it to chat handling.
- `test/streaming-keepalive.test.js`: long-gap and transport-reset regression tests.
- `test/request-log.test.js`: logging allowlist and secret/content exclusion tests.
- `package.json`, `package-lock.json`: test entry and patch version.
- `README.md`, `docs/configuration.md`: corrected runtime and recovery contract.

### Task 1: Keep OpenAI chat event activity alive across mid-stream gaps

**Files:**
- Modify: `test/streaming-keepalive.test.js`
- Modify: `lib/heartbeat.js`
- Modify: `lib/upstream.js`
- Modify: `lib/converters/chat.js`

- [ ] **Step 1: Replace the obsolete stop-after-first-byte assertion with a failing event-heartbeat test**

Change the chat test so the upstream writes `first`, waits 400 ms, then writes
`second`. Configure a 100 ms heartbeat and assert the bytes between the two real
chunks contain a parseable empty `chat.completion.chunk` data event:

```js
async function testChatHeartbeatContinuesDuringMidStreamIdle() {
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"second"}}]}\n\n');
      res.write("data: [DONE]\n\n");
      res.end();
    }, 400);
  }, async (port) => {
    const bridge = startBridge(upstream(port), { heartbeatIntervalMs: 100 });
    const response = await fetch(`http://127.0.0.1:${await bridgePort(bridge)}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    const body = await response.text();
    const between = body.slice(body.indexOf('"first"'), body.indexOf('"second"'));
    const heartbeatLine = between.split("\n").find((line) => line.startsWith("data: ") && line.includes('"chat.completion.chunk"'));
    assert.ok(heartbeatLine, `missing data heartbeat: ${JSON.stringify(between)}`);
    const heartbeat = JSON.parse(heartbeatLine.slice(6));
    assert.equal(heartbeat.model, "test-model");
    assert.deepEqual(heartbeat.choices[0].delta, {});
    await closeBridge(bridge);
  });
}
```

Also update `testChatEmitsHeadersBeforeUpstream` to parse its first `data:` line
and assert `object === "chat.completion.chunk"` with an empty delta, and replace
the old function name in `main()` with
`testChatHeartbeatContinuesDuringMidStreamIdle`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/streaming-keepalive.test.js`

Expected: FAIL in `testChatHeartbeatContinuesDuringMidStreamIdle` because v0.6.1
stops the comment heartbeat after the first upstream byte and emits no OpenAI data
event during the gap.

- [ ] **Step 3: Add a frame option and idle touch to the heartbeat helper**

Keep `: ping` as the default for unchanged protocols. Add a third options argument,
a `lastActivityAt` deadline, and a no-op-compatible `touch()` handle:

```js
function startHeartbeat(res, intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS, options = {}) {
  const frame = typeof options.frame === "string" && options.frame ? options.frame : PING_FRAME;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { stop() {}, touch() {} };
  }

  let timer = null;
  let writing = false;
  let stopped = false;
  let lastActivityAt = Date.now();
  const touch = () => { lastActivityAt = Date.now(); };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (res && typeof res.off === "function") {
      res.off("close", stop);
      res.off("error", stop);
    }
  };

  const tick = async () => {
    if (writing || stopped || Date.now() - lastActivityAt < intervalMs) return;
    writing = true;
    try {
      const ok = await writeWithBackpressure(res, frame);
      if (!ok) stop();
      else lastActivityAt = Date.now();
    } catch {
      stop();
    } finally {
      writing = false;
    }
  };

  if (res && typeof res.on === "function") {
    res.on("close", stop);
    res.on("error", stop);
  }
  if (res && (res.destroyed || res.writableEnded)) {
    stop();
    return { stop, touch };
  }

  timer = setInterval(tick, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return { stop, touch };
}
```

- [ ] **Step 4: Report every real upstream chunk**

Replace `onFirstByte` with an `onChunk` option in `pipeStream` and invoke it once
for every non-empty value before the value is written downstream:

```js
const onChunk = typeof options.onChunk === "function" ? options.onChunk : null;
// inside the read loop, after `done` is checked:
if (onChunk) {
  try { onChunk(value); } catch {}
}
```

- [ ] **Step 5: Generate and use a stable OpenAI empty-delta heartbeat**

In `lib/converters/chat.js`, create one frame per request and leave the heartbeat
running until stream completion:

```js
const { randomUUID } = require("node:crypto");

function chatHeartbeatFrame(model) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-bridge-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  })}\n\n`;
}

const heartbeat = startHeartbeat(res, heartbeatIntervalMs, {
  frame: chatHeartbeatFrame(upstream.model),
});
await pipeStream(upstreamRes.body, res, { onChunk: () => heartbeat.touch() });
heartbeat.stop();
```

- [ ] **Step 6: Run focused and compatibility tests and verify GREEN**

Run: `node test/streaming-keepalive.test.js`

Expected: all streaming keepalive tests pass, including the pre-first-byte test,
mid-stream data-event test, Responses tests, and Anthropic tests.

Run: `node test/security-http.test.js`

Expected: all HTTP security and backpressure tests pass.

- [ ] **Step 7: Commit the heartbeat behavior**

```bash
git add lib/heartbeat.js lib/upstream.js lib/converters/chat.js test/streaming-keepalive.test.js
git commit -m "fix(zcode): keep chat streams active during upstream gaps"
```

### Task 2: Preserve ZCode retry semantics on upstream transport failure

**Files:**
- Modify: `test/streaming-keepalive.test.js`
- Modify: `lib/converters/chat.js`

- [ ] **Step 1: Add a failing abrupt-upstream-reset test**

Create an upstream server that destroys its socket before sending response headers.
The downstream request must reject or its body read must reject; it must not
complete with `upstream_error` and `[DONE]`:

```js
async function testChatTransportFailureResetsDownstream() {
  await withServer((req) => req.socket.destroy(), async (port) => {
    const bridge = startBridge(upstream(port), { heartbeatIntervalMs: 100 });
    try {
      await assert.rejects(async () => {
        const response = await fetch(`http://127.0.0.1:${await bridgePort(bridge)}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }], stream: true }),
        });
        await response.text();
      });
    } finally {
      await closeBridge(bridge);
    }
  });
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/streaming-keepalive.test.js`

Expected: FAIL because v0.6.1 converts the fetch failure to a successful HTTP 200
SSE body containing `upstream_error` and `[DONE]`.

- [ ] **Step 3: Reset the downstream connection on pre-response transport error**

In the streaming `fetchUpstream` catch block, preserve client cancellation and
otherwise destroy the downstream connection without writing a terminal SSE error:

```js
} catch (error) {
  heartbeat.stop();
  if (streamTerminated || res.destroyed || res.writableEnded || client.signal.aborted) return;
  res.destroy(error);
  return;
}
```

Keep the existing HTTP status, empty-body, and non-SSE branches unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node test/streaming-keepalive.test.js`

Expected: all tests pass; the abrupt-reset case terminates as a transport failure.

- [ ] **Step 5: Commit retry semantics**

```bash
git add lib/converters/chat.js test/streaming-keepalive.test.js
git commit -m "fix(zcode): preserve retryable transport failures"
```

### Task 3: Add redacted request diagnostics

**Files:**
- Create: `lib/request-log.js`
- Create: `test/request-log.test.js`
- Modify: `lib/server.js`
- Modify: `lib/converters/chat.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing allowlist and redaction tests**

The tests create a fake request containing safe ZCode IDs plus authorization,
cookie, prompt, and tool content. Capture `console.error` and assert only safe IDs,
route/model, phase, duration, status, and error codes appear:

```js
function captureErrorLine(callback) {
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(String(line));
  try {
    callback();
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  return lines[0];
}

const req = { headers: {
  "x-request-id": "req-safe",
  "x-zcode-trace-id": "trace-safe",
  "x-query-id": "query-safe",
  authorization: "Bearer secret-token",
  cookie: "session=secret-cookie",
} };
const context = requestContext(req, "/v1/chat/completions", "glm-5.2");
const error = Object.assign(new Error("fetch failed secret-token"), {
  code: "UPSTREAM_RESPONSE_FAILED",
  cause: { code: "ECONNRESET", message: "private prompt" },
});
const line = captureErrorLine(() => logRequestEvent(context, "upstream_transport_error", {
  status: 502,
  error,
}));
assert.match(line, /req-safe/);
assert.match(line, /trace-safe/);
assert.match(line, /ECONNRESET/);
assert.doesNotMatch(line, /secret-token|secret-cookie|private prompt|fetch failed/);
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `node test/request-log.test.js`

Expected: FAIL with `MODULE_NOT_FOUND` for `../lib/request-log`.

- [ ] **Step 3: Implement the allowlisted logger**

Create `lib/request-log.js` with these exports and no generic object spreading:

```js
function firstHeader(req, name) {
  const value = req?.headers?.[name];
  return Array.isArray(value) ? value[0] || "" : typeof value === "string" ? value : "";
}

function requestContext(req, route, model) {
  return {
    requestId: firstHeader(req, "x-request-id"),
    traceId: firstHeader(req, "x-zcode-trace-id"),
    queryId: firstHeader(req, "x-query-id"),
    route,
    model,
    startedAt: Date.now(),
  };
}

function safeCode(value) {
  return typeof value === "string" && /^[A-Z0-9_.-]{1,80}$/i.test(value) ? value : "";
}

function logRequestEvent(context, phase, details = {}) {
  const record = {
    phase,
    requestId: context.requestId,
    traceId: context.traceId,
    queryId: context.queryId,
    route: context.route,
    model: context.model,
    elapsedMs: Math.max(0, Date.now() - context.startedAt),
  };
  if (Number.isInteger(details.status)) record.status = details.status;
  const errorName = safeCode(details.error?.name);
  const errorCode = safeCode(details.error?.code);
  const causeCode = safeCode(details.error?.cause?.code);
  if (errorName) record.errorName = errorName;
  if (errorCode) record.errorCode = errorCode;
  if (causeCode) record.causeCode = causeCode;
  console.error(`[bridge] ${JSON.stringify(record)}`);
}
```

- [ ] **Step 4: Pass safe context into chat handling and log lifecycle boundaries**

In `lib/server.js`, after parsing the chat payload:

```js
const context = requestContext(req, pathname, payload.model || "");
await handleChat(upstream, payload, res, server.heartbeatIntervalMs, context);
```

In `handleChat`, log `request_start`, `upstream_headers`,
`upstream_transport_error`, and `request_complete`. Do not pass payloads, headers,
or response bodies into the logger.

- [ ] **Step 5: Add the new test to the package test chain**

Insert `node test/request-log.test.js` before `test/security-http.test.js` in the
`test` script.

- [ ] **Step 6: Run logging and security tests and verify GREEN**

Run: `node test/request-log.test.js`

Expected: all request-log tests pass.

Run: `node test/security-files.test.js && node test/security-http.test.js`

Expected: all security tests pass and no secret-bearing output appears.

- [ ] **Step 7: Commit diagnostics**

```bash
git add lib/request-log.js lib/server.js lib/converters/chat.js test/request-log.test.js package.json
git commit -m "feat: add redacted bridge request diagnostics"
```

### Task 4: Update operator documentation and package version

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Correct the ZCode heartbeat and sleep/wake documentation**

Document these exact guarantees in both English and Chinese sections:

- OpenAI chat uses a valid empty completion data chunk after each configured idle
  interval, before and after real upstream bytes.
- Anthropic and Responses retain their current comment/start-event behavior.
- clamshell sleep suspends the local bridge and breaks open TCP streams;
  after wake, transport failures are exposed so ZCode can retry.
- the bridge does not disable macOS sleep or replay partially consumed requests.

- [ ] **Step 2: Bump the tested patch version without creating a tag**

Run: `npm version 0.6.2 --no-git-tag-version`

Expected: `package.json` and `package-lock.json` both report `0.6.2`; no Git tag is
created.

- [ ] **Step 3: Run documentation/package checks**

Run: `npm run lint`

Expected: all JavaScript syntax checks pass.

Run: `npm run repo:gate`

Expected: repository gate passes with the new public documentation and tests.

Run: `npm pack --dry-run --json`

Expected: exit 0; package contents include runtime files and
`docs/configuration.md`, and exclude internal `docs/superpowers` material.

- [ ] **Step 4: Commit documentation and version**

```bash
git add README.md docs/configuration.md package.json package-lock.json
git commit -m "release: prepare zcode stream recovery v0.6.2"
```

### Task 5: Full verification and local deployment

**Files:**
- No source changes expected.

- [ ] **Step 1: Run the full repository verification suite**

Run: `npm run lint`

Expected: PASS.

Run: `npm test`

Expected: every compatibility, setup, security, streaming, logging, gate, and smoke
test passes.

Run: `npm audit --audit-level=high`

Expected: no high or critical vulnerabilities.

Run: `npm run secretlint`

Expected: no secrets found.

Run: `npm run repo:gate`

Expected: PASS.

Run: `npm run security:scan`

Expected: PASS.

- [ ] **Step 2: Install exactly the tested working tree globally**

Run: `npm install -g .`

Expected: global package installation succeeds without modifying
`~/.llm-coding-bridge/config.json` or ZCode settings.

- [ ] **Step 3: Restart and verify launchd/runtime consistency**

Run: `llm-coding-bridge restart-service --config ~/.llm-coding-bridge/config.json`

Expected: launchd service restarts and listens on `127.0.0.1:37629`.

Verify:

```bash
node -p "require('/opt/homebrew/lib/node_modules/@sevoniva/llm-coding-bridge/package.json').version"
curl -fsS http://127.0.0.1:37629/health
llm-coding-bridge status --config ~/.llm-coding-bridge/config.json
```

Expected: version `0.6.2`, health `{"ok":true}`, package/config/health/models and
launchd status OK. Compare SHA-256 hashes for modified runtime files between the
working tree and global installation.

- [ ] **Step 4: Exercise the real client-managed Finna path without printing the key**

Read the active ZCode provider key from its credential store into an environment
variable without echoing it. Send a small non-stream request and a streaming
request with a deliberate local idle-gap harness. Confirm the real upstream returns
valid GLM output and the bridge emits only redacted request metadata.

- [ ] **Step 5: Verify retry classification and ZCode acceptance**

Use the deterministic abrupt-upstream-reset integration test as the authoritative
transport classification check. Then run a new ZCode multi-tool task while the Mac
remains awake and inspect the corresponding ZCode and bridge logs for:

- request IDs match across the boundary;
- no `stream_idle_timeout` during awake-time gaps;
- a simulated transport failure advances to another attempt instead of ending at
  `unknown retryable=false`;
- the final task completes and the bridge remains healthy.

- [ ] **Step 6: Record final Git and runtime state**

Run: `git status --short && git log -6 --oneline --decorate`

Expected: clean worktree, implementation commits present, no untracked package
tarballs, local service still healthy. Do not push, tag, or publish unless the user
separately requests release publication.
