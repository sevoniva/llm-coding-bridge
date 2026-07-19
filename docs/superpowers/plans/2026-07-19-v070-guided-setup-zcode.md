# v0.7 Guided Setup and ZCode Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make multi-model setup simple and safely write one managed provider into supported ZCode 3.x configuration while preserving every unrelated user field.

**Architecture:** Keep the binary thin and put command parsing, setup orchestration, configuration mutation, credential storage, and the ZCode adapter in separate modules. Every external file mutation follows detect, plan, backup, compare, atomic apply, read-back verify, and rollback. Real upstream keys stay in bridge-owned credential storage; ZCode receives only a generated local bridge token.

**Tech Stack:** Node.js 18+ CommonJS, built-in `readline`/`fs`/`crypto`/`child_process`, macOS Keychain CLI, JSON fixtures, `node:assert`.

---

## File Map

- Create `lib/cli-args.js`: nested commands and strict option parsing.
- Create `lib/config-output.js`: redacted effective output and explicit v1-to-v2 migration.
- Create `lib/credential-store.js`: macOS Keychain storage and portable env/command descriptors.
- Create `lib/setup.js`: normal/advanced guided setup orchestration.
- Create `lib/zcode-client.js`: ZCode detection, plan, apply, verify, remove, and rollback.
- Modify `lib/file-safety.js`: hash-checked atomic JSON replacement and directory fsync.
- Modify `lib/client-setup.js`: shared alias/catalog helpers and legacy compatibility.
- Modify `lib/doctor.js`: selected-model and all-model probes.
- Modify `bin/llm-coding-bridge.js`: delegate new command surface and retain old commands.
- Create `test/cli-args.test.js`: command parser table tests.
- Create `test/config-output.test.js`: effective output, migration, backups, and redaction.
- Create `test/credential-store.test.js`: argv, permissions, and no-secret-output tests.
- Create `test/zcode-client.test.js`: fixture matrix for safe client mutation.
- Create `test/setup.test.js`: isolated-HOME idempotency tests.
- Modify `test/client-setup.test.js`: multi-alias client output.
- Modify `package.json`: register tests and packaged assets.

### Task 1: Add a strict nested command parser

**Files:**
- Create: `lib/cli-args.js`
- Create: `test/cli-args.test.js`
- Modify: `bin/llm-coding-bridge.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing parser table tests**

Cover `setup [--profile FILE] [--advanced]`, `config show --effective`, `config
migrate [--dry-run]`, `client add|remove zcode [--dry-run]`, `client rollback
zcode --backup FILE`, and `doctor --model ALIAS|--all-models`. Reject missing
values, incompatible flags, duplicate singleton flags, unknown clients, and
positional data after the command.

```js
assert.deepEqual(parseCliArgs(["client", "add", "zcode", "--dry-run", "--home", "/tmp/home"]), {
  command: "client",
  action: "add",
  client: "zcode",
  dryRun: true,
  home: "/tmp/home",
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node test/cli-args.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/cli-args`.

- [ ] **Step 3: Implement parsing without side effects**

Return a frozen object, never read the filesystem during parse, and retain all
0.6 commands as explicit compatibility commands. Update usage text with the new
normal path first and compatibility commands in an advanced section.

- [ ] **Step 4: Run focused tests and commit**

Run: `node test/cli-args.test.js`

Expected: `CLI argument tests passed`.

```bash
git add lib/cli-args.js bin/llm-coding-bridge.js test/cli-args.test.js package.json
git commit -m "feat(cli): add v0.7 command surface"
```

### Task 2: Add redacted effective config and explicit migration

**Files:**
- Create: `lib/config-output.js`
- Create: `test/config-output.test.js`
- Modify: `lib/file-safety.js`
- Modify: `bin/llm-coding-bridge.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing redaction and migration tests**

Assert `config show --effective` displays aliases, provider IDs, base URLs,
credential source type/reference, policy values, and provenance but never env
values, command stdout, local token, upstream key, or raw client key. Dry-run
migration must print a redacted version 2 document and make no file changes.
Confirmed migration must back up once, write mode `0600`, and preserve version 1
behavior after reload.

- [ ] **Step 2: Add failing concurrent-change and durability tests**

Read a file snapshot, modify it between planning and apply, and assert apply
stops without creating a replacement. Assert the same-directory temp file is
fsynced, renamed, chmodded, and followed by directory fsync. Exercise a symlink
whose owned regular-file target is updated while the symlink inode remains.

- [ ] **Step 3: Run the focused test and verify RED**

Run: `node test/config-output.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/config-output` or missing hash-checked
replacement support.

- [ ] **Step 4: Extend file safety with snapshot/apply primitives**

Export `readFileSnapshot(file)`, `atomicReplacePrivate(snapshot, data)`, and
`verifyPrivateRegularFile(file)`. A snapshot contains requested path, resolved
target, SHA-256, stat identity, and bytes. Before rename, re-read and compare
hash plus inode/device when available. Keep `writePrivateFile()` behavior for
existing callers.

- [ ] **Step 5: Implement effective output and migration**

Export `effectiveConfigDocument(config)` and
`migrationPlan(config, snapshot)`. Migration assigns stable provider IDs from
safe normalized names, assigns a credential reference per route, and never runs
automatically on install, serve, doctor, or status.

- [ ] **Step 6: Run focused/security tests and commit**

Run: `node test/config-output.test.js && node test/security-files.test.js && npm run secretlint`

Expected: all pass.

```bash
git add lib/config-output.js lib/file-safety.js bin/llm-coding-bridge.js test/config-output.test.js package.json
git commit -m "feat(config): preview and safely migrate version 2"
```

### Task 3: Store independent model keys without writing them to config

**Files:**
- Create: `lib/credential-store.js`
- Create: `test/credential-store.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write failing platform adapter tests**

Inject a process runner; do not touch the developer Keychain in tests. On macOS,
assert every alias uses a separate service/account tuple and returns a command
descriptor using `/usr/bin/security find-generic-password -s SERVICE -a ACCOUNT
-w`. On other platforms, produce an env descriptor with a validated unique
variable name. Capture stdout/stderr/errors and assert the supplied key never
appears.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/credential-store.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/credential-store`.

- [ ] **Step 3: Implement Keychain save/read/delete operations**

Use `spawnSync` with an executable plus argv array and `shell: false`; never
construct shell commands. Validate aliases before using them in service/account
names. Suppress child output during save/delete, cap execution time, and return
safe codes only. Do not accept secret values through CLI flags or write them to
history, config, state, logs, errors, or tests.

- [ ] **Step 4: Add an interactive no-echo secret reader**

When stdin is a TTY, use raw mode to collect a line, render only masking dots,
restore terminal state in `finally`, and zero the temporary Buffer after the
credential adapter returns. For non-interactive setup, accept only env or
command references, never a literal key on stdin mixed with other answers.

- [ ] **Step 5: Run focused/security tests and commit**

Run: `node test/credential-store.test.js && npm run security:scan && npm run secretlint`

Expected: all pass and the captured key is absent from every output.

```bash
git add lib/credential-store.js lib/setup.js test/credential-store.test.js package.json
git commit -m "feat(setup): store independent model credentials"
```

### Task 4: Implement the ZCode adapter contract

**Files:**
- Create: `lib/zcode-client.js`
- Create: `test/zcode-client.test.js`
- Modify: `lib/file-safety.js`
- Modify: `package.json`

- [ ] **Step 1: Build the failing fixture matrix**

Under a temporary HOME, cover absent config, built-in providers, unrelated
custom providers, unknown root/provider fields, malformed JSON, root arrays,
missing provider objects, modes `0644` and `0600`, relative/absolute symlinks,
unowned/non-file symlink targets, concurrent changes, repeated add, remove,
selected-backup rollback, missing state, one adoptable match, and ambiguous
matches. Also create `~/.zcode/cli/config.json` and assert its bytes never change.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node test/zcode-client.test.js`

Expected: `MODULE_NOT_FOUND` for `../lib/zcode-client`.

- [ ] **Step 3: Implement detection and pure planning**

Recognize only tested ZCode 3.x plus the `~/.zcode/v2/config.json` schema.
`planZcodeChange({ action, config, home, state })` returns exact JSON-pointer-like
changes and warnings but writes nothing. Unknown major versions/schemas return
preview-only. The managed provider has a random persisted ID, name `LLM Coding
Bridge`, kind `openai-compatible`, source `custom`, local `/v1` base URL, local
bridge token, and every client alias/capability.

- [ ] **Step 4: Implement backup, hash-checked apply, and verify**

Back up the resolved target with mode `0600`, preserve every field outside the
managed provider, apply through `atomicReplacePrivate`, chmod `0600`, read back,
and verify provider ID, local URL/token, aliases, and unrelated provider hashes.
If any post-write check fails, restore the just-created backup and report a safe
rollback result.

- [ ] **Step 5: Implement remove and explicit rollback**

Remove only the managed provider ID stored in private bridge state. Rollback
accepts an explicit bridge-created backup, validates it is a regular file under
the target directory, previews the replacement, backs up current state, and
atomically restores. Never delete ZCode credentials or unrelated providers.

- [ ] **Step 6: Run the fixture matrix and commit**

Run: `node test/zcode-client.test.js && node test/security-files.test.js`

Expected: every fixture passes and all written files are `0600`.

```bash
git add lib/zcode-client.js lib/file-safety.js test/zcode-client.test.js package.json
git commit -m "feat(zcode): safely manage one local bridge provider"
```

### Task 5: Implement simple guided setup and idempotent client commands

**Files:**
- Create: `lib/setup.js`
- Create: `test/setup.test.js`
- Modify: `lib/client-setup.js`
- Modify: `lib/doctor.js`
- Modify: `bin/llm-coding-bridge.js`
- Modify: `package.json`

- [ ] **Step 1: Write a failing isolated-HOME setup test**

Feed normal setup answers for one shared provider, two aliases, two exact model
IDs, independent credential adapters, ZCode selected, no service restart, and
fake doctor success. Run setup twice. Assert the bridge config and managed ZCode
provider are equivalent, a second unrelated provider remains byte-equivalent,
backups exist, configs are `0600`, local token is stable, and no upstream key is
present in either JSON file.

- [ ] **Step 2: Run the test and verify RED**

Run: `node test/setup.test.js`

Expected: setup still accepts only one model and cannot configure ZCode JSON.

- [ ] **Step 3: Implement the normal setup flow**

Ask only provider name/base URL, repeated alias/upstream ID/key, clients,
service/restart, and probe scope. Generate a cryptographically random local
token. Hide reliability limits behind stable defaults. `--advanced` additionally
collects capabilities, named policy, and explicit client-provided credential
mode. `--profile FILE` reads validated data only and cannot execute code.

- [ ] **Step 4: Wire client commands and process handling**

`client add/remove/rollback zcode` call the adapter. `--dry-run` prints changes
and makes no write. Interactive add detects a running ZCode process and asks
before quit/restart; non-interactive mutation requires `--yes` and never quits
or restarts unless `--restart-zcode` is also explicit.

- [ ] **Step 5: Extend doctor selection**

`doctor --model ALIAS` probes one normalized route. `doctor --all-models` probes
routes sequentially by default, prints one safe line per alias, and exits nonzero
when any route fails without disclosing returned content or credentials.

- [ ] **Step 6: Run setup and compatibility tests**

Run: `node test/setup.test.js && node test/client-setup.test.js && node test/cli-args.test.js && npm test`

Expected: all tests pass, including old `init` and client setup workflows.

- [ ] **Step 7: Commit guided setup integration**

```bash
git add lib/setup.js lib/client-setup.js lib/doctor.js bin/llm-coding-bridge.js test/setup.test.js test/client-setup.test.js
git commit -m "feat(setup): configure multi-model bridge and zcode"
```

## Plan Acceptance

- [ ] Normal setup does not ask about sockets, heartbeat, retry counts, backoff, or byte limits.
- [ ] Real upstream keys are absent from bridge JSON, ZCode JSON, logs, errors, shell history, and fixtures.
- [ ] ZCode add is idempotent, backup-first, hash-checked, atomic, symlink-preserving, and mode `0600`.
- [ ] Remove and rollback affect only the bridge-managed provider or selected bridge backup.
- [ ] Unknown ZCode schema/version is preview-only.
- [ ] Version 1 configuration and old CLI commands remain supported through 0.7.x.
