# v0.7 Local Reliability Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a loopback-only, dependency-free console that explains route health, request attempts, client configuration, and doctor results without exposing prompts, outputs, headers, or credentials.

**Architecture:** Add a small admin router to the existing HTTP server. Read-only JSON is generated from frozen redacted snapshots; state-changing doctor actions require both a loopback peer and configured local authentication. Static files are packaged assets served from fixed allowlisted paths with a restrictive CSP.

**Tech Stack:** Node.js 18+ CommonJS, built-in `http`/`fs`, vanilla HTML/CSS/JavaScript, `node:assert`, no runtime dependencies.

---

## File Map

- Create `lib/admin.js`: peer/auth checks, safe JSON handlers, doctor action dispatch.
- Create `lib/admin-status.js`: assemble redacted runtime and client snapshots.
- Create `assets/admin/index.html`: accessible console structure.
- Create `assets/admin/admin.css`: responsive local dashboard styles.
- Create `assets/admin/admin.js`: status/events polling and doctor controls.
- Modify `lib/server.js`: fixed admin route dispatch and runtime wiring.
- Modify `lib/doctor.js`: return safe structured results in addition to CLI output.
- Modify `lib/zcode-client.js`: read-only managed-client verification snapshot.
- Create `test/admin.test.js`: loopback, auth, redaction, route, and action tests.
- Create `test/admin-page.test.js`: asset/CSP/accessibility/rendering smoke tests.
- Modify `package.json`: include assets and register tests/lint.

### Task 1: Assemble safe status snapshots

**Files:**
- Create: `lib/admin-status.js`
- Create: `test/admin.test.js`
- Modify: `lib/zcode-client.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing snapshot and redaction tests**

Construct runtime data containing credentials, prompts, responses, headers,
reasoning, tool arguments, raw errors, and provider response bodies. Assert the
snapshot contains only bridge version/uptime/config source, alias capabilities,
credential availability booleans, health/cooldown counters, safe event fields,
and ZCode version/managed status/last verification.

```js
assert.deepEqual(snapshot.routes[0], {
  alias: "coding-fast",
  credentialAvailable: true,
  health: "closed",
  consecutiveFailures: 0,
  cooldownUntil: null,
  halfOpenProbeActive: false,
  lastSuccessAt: 1000,
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/admin.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/admin-status`.

- [ ] **Step 3: Implement snapshot composition from public APIs only**

Export `buildAdminStatus(runtime, options)`. Do not inspect private fields of the
credential resolver, health registry, or event store. Return a deep-frozen
object and include no filesystem content beyond canonical config path and safe
client status.

- [ ] **Step 4: Add read-only ZCode verification**

Return version, supported/preview-only state, managed provider present, alias
count, file mode-private boolean, and last verified timestamp. Do not return
provider JSON, local token, upstream keys, or unrelated provider names.

- [ ] **Step 5: Run focused tests and commit**

Run: `node test/admin.test.js && node test/zcode-client.test.js`

Expected: both suites pass.

```bash
git add lib/admin-status.js lib/zcode-client.js test/admin.test.js package.json
git commit -m "feat(admin): expose redacted reliability status"
```

### Task 2: Enforce admin peer and authentication boundaries

**Files:**
- Create: `lib/admin.js`
- Modify: `lib/server.js`
- Modify: `test/admin.test.js`

- [ ] **Step 1: Write failing peer/auth matrix tests**

Test IPv4 loopback, IPv6 loopback, IPv4-mapped loopback, non-loopback peer,
spoofed `X-Forwarded-For`, missing/wrong/correct bearer token, GET status/events,
POST doctor, unsupported methods, oversized JSON, and disallowed Origin. A
non-loopback peer always gets 403 even with a valid token. If no local token is
configured, GET remains loopback-only but POST doctor returns 409
`admin_auth_not_configured`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/admin.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/admin`.

- [ ] **Step 3: Implement fixed admin routing**

Handle only `/admin`, `/admin/admin.css`, `/admin/admin.js`,
`/admin/api/status`, `/admin/api/events`, and `/admin/api/doctor`. Determine peer
from `req.socket.remoteAddress` only. Reuse constant-time local-token comparison.
Do not accept file names, redirects, templates, proxy headers, or arbitrary
doctor commands from request input.

- [ ] **Step 4: Add browser security headers**

Set `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src
'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors
'none'; form-action 'none'`, plus `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and no wildcard CORS.

- [ ] **Step 5: Run HTTP security tests and commit**

Run: `node test/admin.test.js && node test/security-http.test.js`

Expected: all peer, auth, origin, content-type, and header assertions pass.

```bash
git add lib/admin.js lib/server.js test/admin.test.js
git commit -m "feat(admin): protect local console routes"
```

### Task 3: Add safe doctor actions

**Files:**
- Modify: `lib/doctor.js`
- Modify: `lib/admin.js`
- Modify: `test/admin.test.js`

- [ ] **Step 1: Write failing action tests**

POST JSON `{ "model": "coding-fast" }` and `{ "allModels": true }`; reject
unknown aliases, both fields together, extra fields, non-JSON input, and bodies
over 16 KiB. Assert only one doctor action per alias runs concurrently and that
results contain alias, boolean success, safe category/code, and elapsed time.

- [ ] **Step 2: Refactor doctor into structured and CLI layers**

Export `probeModel(config, alias, options)` and `probeAllModels(config, options)`
that return safe records. Keep `doctor()` responsible for human-readable output
and exit code. Never return model text; compare the exact probe response in
memory and discard it.

- [ ] **Step 3: Wire the allowlisted POST action**

Run probes through a small in-memory lock keyed by alias. Append start/result
events to the redacted store. Do not expose cooldown reset, arbitrary URLs,
credential reload, shell commands, service restart, or client mutation through
the console.

- [ ] **Step 4: Run focused tests and commit**

Run: `node test/admin.test.js && node test/smoke.js`

Expected: both suites pass.

```bash
git add lib/doctor.js lib/admin.js test/admin.test.js
git commit -m "feat(admin): run authenticated model probes"
```

### Task 4: Build the dependency-free console page

**Files:**
- Create: `assets/admin/index.html`
- Create: `assets/admin/admin.css`
- Create: `assets/admin/admin.js`
- Create: `test/admin-page.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing asset and rendering smoke tests**

Assert all three fixed assets exist in `npm pack --dry-run`, HTML has one `main`,
semantic headings, status/live regions, route table, event timeline, doctor
buttons, keyboard-usable controls, and external same-origin CSS/JS only. Assert
JavaScript uses `textContent`, never `innerHTML`, `eval`, dynamic Function, or
remote assets.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/admin-page.test.js`

Expected: assets are missing.

- [ ] **Step 3: Implement accessible status rendering**

Poll status every five seconds and events with `afterSequence`; pause polling
when the page is hidden, resume on visibility change, and use an abort timeout.
Show route state, last success, failures, cooldown, attempts/backoff/heartbeat,
and ZCode managed status. Render all server strings with `textContent`.

- [ ] **Step 4: Implement conservative visual styling**

Support light/dark system themes, 320px width, reduced motion, high-contrast
focus, tabular timings, and overflow-safe tables. Avoid fonts, icons, scripts,
or analytics from external origins.

- [ ] **Step 5: Run asset, pack, and security tests**

Run: `node test/admin-page.test.js && npm run pack:check && npm run security:scan && npm run secretlint`

Expected: all pass and `assets/admin/*` appears in the package file list.

- [ ] **Step 6: Commit the console assets**

```bash
git add assets/admin lib/admin.js test/admin-page.test.js package.json
git commit -m "feat(admin): add local reliability console"
```

### Task 5: Complete console integration

**Files:**
- Modify: `lib/server.js`
- Modify: `lib/request-log.js`
- Modify: `test/admin.test.js`
- Modify: `test/smoke.js`

- [ ] **Step 1: Add a failing end-to-end timeline test**

Start the real bridge against a scripted fake upstream that fails once, waits,
then succeeds. Fetch `/admin/api/status` and `/admin/api/events`; assert the
timeline contains accepted, attempts, retry delay, heartbeat count, and completed
without any request body or completion text.

- [ ] **Step 2: Pass runtime snapshots into the admin router**

Wire the already-created server-scoped event store, health registry, credential
availability, start time, config source, and ZCode read-only status. Admin code
must never influence route selection, retry decisions, or stream progress.

- [ ] **Step 3: Run complete tests and security gates**

Run: `npm test && npm run lint && npm run security:scan && npm run secretlint && npm run repo:gate`

Expected: every command exits 0.

- [ ] **Step 4: Commit console integration**

```bash
git add lib/server.js lib/request-log.js test/admin.test.js test/smoke.js
git commit -m "feat(admin): connect live reliability timelines"
```

## Plan Acceptance

- [ ] Every admin route rejects non-loopback peers regardless of token or proxy headers.
- [ ] State-changing actions require a configured valid local token.
- [ ] Console JSON and HTML never contain prompts, outputs, reasoning, tool arguments, headers, bodies, keys, or raw errors.
- [ ] The event ring is bounded and polling supports a monotonic cursor.
- [ ] The page has no remote assets, inline executable code, unsafe DOM insertion, or telemetry.
- [ ] Admin availability or failure cannot change routing/retry behavior.
