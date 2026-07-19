# v0.7 Production Validation and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove v0.7.0 is production-ready with deterministic multi-model faults, a 20-minute soak, security and packaging gates, secure real-model acceptance, ZCode verification, and an auditable GitHub/npm release.

**Architecture:** Keep fake-upstream acceptance deterministic and credential-free, aggregate all local gates in one `verify` script, and make the long soak a separate required release gate. Real credentials enter only through the finished no-echo setup flow after automated/security gates pass. Tag publication occurs from clean `main` only after live acceptance.

**Tech Stack:** Node.js 18+ CommonJS, built-in HTTP/fetch, GitHub Actions/CodeQL, Semgrep, OSV Scanner, secretlint, npm audit/provenance, GitHub CLI, npm registry.

---

## File Map

- Create `test/helpers/fake-multimodel-upstream.js`: one endpoint, route-specific keys, scripted faults.
- Create `test/multimodel-e2e.test.js`: routing, credentials, retries, cooldown, admin, and doctor acceptance.
- Create `scripts/fault-soak.js`: deterministic 20-minute mixed-fault runner and report.
- Create `scripts/release-gate.js`: clean-main, version, tag, package, and public-content checks.
- Modify `scripts/security-scan.js`: cover recursive JavaScript/assets and unsafe secret/process/DOM patterns.
- Modify `scripts/repo-gate.js`: verify package files, workflows, and release invariants.
- Modify `.github/workflows/ci.yml`: supported Node matrix and complete fast gate.
- Modify `.github/workflows/security.yml`: security scanners and immutable action references.
- Modify `.github/workflows/publish.yml`: verify/tag-version match, pack check, and provenance publish.
- Modify `package.json`: `verify`, `test:soak`, test registration, and final `0.7.0` version.
- Modify `package-lock.json`: synchronized version and resolved dependency metadata.
- Modify `README.md`: simple v0.7 setup, aliases, ZCode, reliability, console, and upgrade guide.
- Modify `docs/configuration.md`: complete generic v2 reference and recovery runbook.
- Create `docs/release-checklist.md`: repeatable local/live/release evidence checklist.
- Create `docs/releases/v0.7.0.md`: provider-neutral release notes and compatibility statement.

### Task 1: Build a deterministic shared-endpoint acceptance harness

**Files:**
- Create: `test/helpers/fake-multimodel-upstream.js`
- Create: `test/multimodel-e2e.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing end-to-end acceptance scenarios**

Configure one base URL with aliases `coding-fast`, `coding-strong`, and
`coding-long`, exact upstream IDs `provider-model-id-a`,
`provider-model-id-b`, and `provider-model-id-c`, and three independent test
keys generated in memory. Assert every alias sends only its assigned model/key.
Script 401 rotation, 429 retry-after, 503, invalid HTTP 200 JSON, valid non-SSE
completion, slow first data, idle gaps, resets before/after semantic content,
and per-route cooldown.

- [ ] **Step 2: Add client and console assertions**

Exercise `/health`, `/v1/models`, Chat, Responses, Anthropic, one-model doctor,
all-model doctor, admin status/events, and a ZCode fixture generated from the
same normalized config. Assert all displayed model strings are aliases and no
test key appears in response bodies, captured logs, admin JSON, config JSON, or
ZCode JSON.

- [ ] **Step 3: Run the new test and verify RED**

Run: `node test/multimodel-e2e.test.js`

Expected: `MODULE_NOT_FOUND` for `./helpers/fake-multimodel-upstream`.

- [ ] **Step 4: Implement the reusable scripted upstream**

Expose `startFakeMultiModel({ routes, scripts, clock })`,
`requestsFor(alias)`, `rotateKey(alias, nextKey)`, `setScript(alias, steps)`, and
`close()`. Validate authorization with constant-time comparison, cap request
bodies, bind loopback on an ephemeral port, and retain only request number,
model ID, authorization match boolean, and timestamps.

- [ ] **Step 5: Run the end-to-end test and commit**

Run: `node test/multimodel-e2e.test.js`

Expected: `multi-model end-to-end tests passed`.

```bash
git add test/helpers/fake-multimodel-upstream.js test/multimodel-e2e.test.js package.json
git commit -m "test: add multi-model production acceptance harness"
```

### Task 2: Add a real-time 20-minute fault-injection soak

**Files:**
- Create: `scripts/fault-soak.js`
- Modify: `package.json`
- Create: `docs/release-checklist.md`

- [ ] **Step 1: Write a failing short-mode smoke assertion**

Run the soak with `--duration-ms 3000 --seed 7070 --report FILE` from a test
that provides a temporary report path. Assert the report schema has duration,
seed, route request/success/recovery/failure counters, fault counters, maximum
attempt/backoff/heartbeat gap, semantic replay count, leaked-secret count, and
process unhandled rejection/exception count.

- [ ] **Step 2: Run short mode and verify RED**

Run: `node scripts/fault-soak.js --duration-ms 3000 --seed 7070 --report /tmp/llm-coding-bridge-soak.json`

Expected: `MODULE_NOT_FOUND` for `scripts/fault-soak.js`.

- [ ] **Step 3: Implement deterministic weighted faults**

Cycle all three aliases and inject slow first content, 20-second mid-stream
gaps, valid non-SSE success, invalid HTTP 200 bodies, abrupt resets, 408, 429,
5xx, credential rotation, two consecutive failures, and post-semantic resets.
Use a seeded PRNG. Remove the report on success unless `--report` is provided;
never write keys, prompts, or completion content.

- [ ] **Step 4: Define hard soak invariants**

Exit nonzero for any secret leak, semantic replay, alias/model/key mismatch,
unhandled rejection/exception, event-ring overflow beyond capacity, successful
request during an ineligible cooldown, missing heartbeat longer than two
configured intervals plus 500 ms, leaked socket/timer, or unexplained terminal
failure. Post-semantic reset is expected only when exactly one upstream attempt
occurred and the downstream transport failed.

- [ ] **Step 5: Run short mode and normal tests**

Run: `node scripts/fault-soak.js --duration-ms 3000 --seed 7070 --report /tmp/llm-coding-bridge-soak.json && npm test`

Expected: short report has `ok: true`; all tests pass.

- [ ] **Step 6: Document and commit the soak gate**

Add the exact release command `npm run test:soak`, expected duration of 20
minutes, report location, invariants, and interruption behavior to the release
checklist.

```bash
git add scripts/fault-soak.js docs/release-checklist.md package.json
git commit -m "test: add twenty-minute reliability soak"
```

### Task 3: Strengthen automated security and repository gates

**Files:**
- Create: `scripts/release-gate.js`
- Modify: `scripts/security-scan.js`
- Modify: `scripts/repo-gate.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/security.yml`
- Modify: `.github/workflows/publish.yml`
- Modify: `package.json`
- Create: `test/release-gate.test.js`

- [ ] **Step 1: Write failing release/security gate tests**

Use temporary fixture repositories to prove the gates reject unpinned Actions,
tag/package version mismatch, literal keys, shell-enabled process execution,
dynamic code, unsafe admin DOM insertion, remote admin assets, missing packaged
files, writable secret-bearing fixture files, provider-specific public terms,
and a dirty release worktree. Assert safe fixtures pass.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/release-gate.test.js`

Expected: missing release-gate behaviors fail.

- [ ] **Step 3: Make static scans recursive and allowlist exceptions narrowly**

Scan JavaScript under `bin`, `lib`, `scripts`, `test`, and admin assets. Check
unsafe child-process, shell, dynamic-code, secret, traversal, and unsafe-DOM
patterns. Use file/line-specific code comments for any necessary false-positive
suppression; a broad directory or rule disable is not accepted.

- [ ] **Step 4: Create one fast verification command**

Set `npm run verify` to run syntax/lint, complete tests, security scan,
secretlint, repository gate, high-severity npm audit against npmjs, and dry-run
packing. Keep `npm run test:soak` separate because it is a 20-minute release
gate rather than a per-commit check.

- [ ] **Step 5: Harden CI and publish workflows**

Run compatibility tests on Node 18, 20, 22, and 24 while running audit/pack once
on Node 24. Keep every external action pinned to a 40-character commit SHA.
Before publish, assert `GITHUB_REF_NAME` equals `v${package.version}`, run
`npm run verify`, run `npm pack --dry-run`, and publish with provenance and
public access only if that exact version is not already present.

- [ ] **Step 6: Run local security gates and the standard security-review skill**

Run: `npm run verify`

Expected: every subcommand exits 0.

Then run the repository through `codex-security:security-scan`, fix every
validated high/medium finding in scope, rerun focused regression tests, and
record zero unresolved release-blocking findings in the release checklist.

- [ ] **Step 7: Commit gate hardening**

```bash
git add scripts/security-scan.js scripts/repo-gate.js scripts/release-gate.js .github/workflows/ci.yml .github/workflows/security.yml .github/workflows/publish.yml test/release-gate.test.js package.json docs/release-checklist.md
git commit -m "chore(security): harden v0.7 release gates"
```

### Task 4: Update provider-neutral public documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Create: `docs/releases/v0.7.0.md`
- Modify: `docs/release-checklist.md`

- [ ] **Step 1: Add a failing public-content scan**

Extend the release-gate fixture and real-repository check with an exact
case-insensitive denylist loaded from the untracked private file named by
`LLM_BRIDGE_PRIVATE_TERMS_FILE`. Assert README,
configuration, release notes, templates, examples, package metadata, and admin
assets contain no private provider name, private model ID, real endpoint, key,
trace ID, session ID, or machine-specific home path.

- [ ] **Step 2: Rewrite the normal path around `setup`**

Lead with install, `llm-coding-bridge setup`, independent keys per alias, direct
ZCode configuration, service start/restart, `/admin`, and doctor. Keep advanced
manual JSON, version 1, client-provided keys, and migration in later sections.
State clearly that package installation never rewrites local bridge/client
configuration.

- [ ] **Step 3: Document the exact reliability contract**

Describe pre-semantic same-model retries, no replay after text/reasoning/refusal/
tool output, phase deadlines, heartbeat scope, retry-after/backoff limits,
per-route cooldown, non-SSE compatibility, transport reset semantics, and what
sleep/wake recovery can and cannot guarantee.

- [ ] **Step 4: Document ZCode safety and recovery**

List the supported ZCode 3.x file, managed provider ownership, local token versus
upstream key, backups, mode `0600`, symlink/concurrency behavior, dry-run,
remove, rollback, unknown-version preview-only behavior, and the explicit fact
that `~/.zcode/cli/config.json` is not modified.

- [ ] **Step 5: Write v0.7.0 release notes**

Include features, reliability behavior, security boundaries, version 1
compatibility, migration steps, known limits, verification evidence fields, and
rollback to v0.6.3. Do not claim real-model or sleep/wake validation until the
corresponding checklist rows contain evidence.

- [ ] **Step 6: Run docs, secret, and pack gates and commit**

Run: `npm run repo:gate && npm run secretlint && npm run pack:check`

Expected: provider-neutral and package-content gates pass.

```bash
git add README.md docs/configuration.md docs/releases/v0.7.0.md docs/release-checklist.md
git commit -m "docs: publish v0.7 setup and reliability contract"
```

### Task 5: Run the automated production gate before requesting real models

**Files:**
- Modify: `docs/release-checklist.md`

- [ ] **Step 1: Verify the real branch and package boundary**

Run: `git status --short --branch && git log --oneline --decorate -8 && node -p "require('./package.json').version" && npm view @sevoniva/llm-coding-bridge version --registry=https://registry.npmjs.org/`

Expected before release: feature branch is clean, local version is still the
development version, and npm remains `0.6.3`.

- [ ] **Step 2: Run the full fast gate**

Run: `npm ci && npm run verify`

Expected: clean install, lint, complete tests, security scan, secret scan,
repository gate, dependency audit, and dry-run pack all pass.

- [ ] **Step 3: Run setup twice in an isolated HOME**

Use the fake shared endpoint and a temporary HOME. Run normal setup, add ZCode,
run it again, remove, add, and rollback. Verify config equality after the second
setup, private modes, preserved unrelated providers, backed-up targets, valid
doctor results, and no key in any file or captured output.

- [ ] **Step 4: Run the full 20-minute soak without shortening it**

Run: `npm run test:soak`

Expected after at least 1,200,000 ms: report has `ok: true`, all configured fault
types occurred, every alias completed successful recoveries, semantic replay and
secret leak counts are zero, and unhandled error count is zero.

- [ ] **Step 5: Run security review and inspect package bytes**

Run: `npm pack --json` and inspect the exact file list and tarball contents.
Run the standard security-review skill after the final automated changes. Mark
the gate passed only when there are no unresolved release-blocking findings and
all remediations have green regression tests.

- [ ] **Step 6: Commit checklist evidence**

Record commands, timestamps, Node versions, duration, counts, package SHA-256,
and pass/fail outcomes without machine username, keys, private provider names,
model IDs, or endpoints.

```bash
git add docs/release-checklist.md
git commit -m "test: record v0.7 automated production evidence"
```

### Task 6: Request and run secure real multi-model acceptance

**Files:**
- Modify: `docs/release-checklist.md`

- [ ] **Step 1: Ask for non-secret route metadata**

Only after Task 5 passes, ask the user for the shared base URL plus at least
three desired client aliases and exact upstream model IDs. Do not ask the user
to paste keys into chat or a command line argument.

- [ ] **Step 2: Collect each key through the no-echo setup prompt**

Run `llm-coding-bridge setup` interactively and let the user enter each model's
key directly into the hidden prompt. Save separate Keychain entries, verify the
resulting config contains only credential references, and clear temporary shell
environment values used for testing.

- [ ] **Step 3: Probe each model and every public protocol**

Run `doctor --all-models`, then one Chat, Responses, and Anthropic request per
alias. Verify exact routing from safe request metadata and successful content
locally without recording the content. Rotate or deliberately invalidate one
test credential, prove only that route refreshes/fails, then restore it.

- [ ] **Step 4: Apply and verify ZCode configuration**

Run `client add zcode --dry-run`, inspect the field plan, confirm apply/restart,
open ZCode, select each alias, and complete one real coding turn per model. Read
back the config and verify only the managed provider changed and it contains the
local bridge token rather than any upstream key.

- [ ] **Step 5: Validate live interruption and sleep/wake recovery**

During a pre-content wait, interrupt and restore network access; verify the same
bridge request recovers within policy. Start another long turn, perform a user-
approved macOS sleep/wake cycle, and verify either safe pre-content recovery or
a downstream reset that ZCode retries without duplicate semantic output. Observe
the console/log timeline for at least 20 minutes and require no unexplained
terminal failure.

- [ ] **Step 6: Remove live secrets from transient test state**

Keep only intended Keychain entries and user configuration. Delete temporary
reports/configs, search logs and repository for supplied secret fingerprints,
and require zero matches. Do not commit live endpoint, provider name, model ID,
trace/session ID, or credential.

- [ ] **Step 7: Record redacted live evidence and commit**

Record alias count, protocol matrix result, ZCode version, interruption result,
sleep/wake result, observation duration, and zero-leak check without private
identifiers.

```bash
git add docs/release-checklist.md
git commit -m "test: record redacted v0.7 live acceptance"
```

### Task 7: Prepare, merge, tag, publish, and verify v0.7.0

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `docs/releases/v0.7.0.md`
- Modify: `docs/release-checklist.md`

- [ ] **Step 1: Bump the release version only after live acceptance**

Run: `npm version 0.7.0 --no-git-tag-version`

Expected: `package.json` and `package-lock.json` both report `0.7.0`; no tag is
created yet.

- [ ] **Step 2: Finalize release notes and rerun every gate**

Run: `npm ci && npm run verify && npm run test:soak`

Expected: fast gates exit 0 and the full 20-minute report has `ok: true`.

- [ ] **Step 3: Commit the release candidate**

```bash
git add package.json package-lock.json docs/releases/v0.7.0.md docs/release-checklist.md
git commit -m "release: prepare v0.7.0"
```

- [ ] **Step 4: Review and merge to `main`**

Use the required branch review and verification skills, inspect the complete
diff from `origin/main`, resolve every release-blocking finding, and rerun
focused tests. Fast-forward or merge the reviewed feature branch into `main`
without rewriting user commits. Confirm `main` is clean and contains the exact
reviewed release commit.

- [ ] **Step 5: Push `main` and wait for CI/security success**

Run: `git push origin main`

Use `gh run list`/`gh run watch` to require CI, CodeQL, and Security workflows
for the release commit to finish successfully before tagging.

- [ ] **Step 6: Tag and publish through the protected workflow**

Run: `git tag -a v0.7.0 -m "v0.7.0" && git push origin v0.7.0`

Wait for the Publish Package workflow to finish successfully. If it fails, do
not move or recreate the tag; diagnose, fix on a new patch version if package
contents changed, and preserve the audit trail.

- [ ] **Step 7: Create the GitHub release**

Run: `gh release create v0.7.0 --title "v0.7.0" --notes-file docs/releases/v0.7.0.md --verify-tag`

Expected: a public non-draft release attached to the exact annotated tag.

- [ ] **Step 8: Verify npm, provenance, install, and rollback path**

Run: `npm view @sevoniva/llm-coding-bridge@0.7.0 version dist.integrity dist.tarball --json --registry=https://registry.npmjs.org/`

Install `@sevoniva/llm-coding-bridge@0.7.0` into a fresh temporary prefix, run
`--help`, load a version 1 config, run fake version 2 doctor/setup dry-run, and
verify the binary reports 0.7.0. Confirm v0.6.3 remains installable as the
documented rollback.

## Plan Acceptance

- [ ] The complete deterministic multi-model matrix passes with independent credentials and route health.
- [ ] The full real-time soak runs at least 20 minutes with zero replay, secret leak, unhandled error, or unexplained terminal failure.
- [ ] Local verify, dependency audit, secret scan, static scan, repository gate, CodeQL, Semgrep, OSV, CI, and publish gates pass.
- [ ] At least three real model IDs/keys are accepted securely and pass all-model, protocol, ZCode, interruption, and sleep/wake checks.
- [ ] Public repository/package content remains provider-neutral and contains no live identifiers or secrets.
- [ ] `main`, annotated tag `v0.7.0`, GitHub release, and npm `0.7.0` all resolve to the same tested commit/package.
- [ ] A fresh install works and the documented v0.6.3 rollback remains available.
