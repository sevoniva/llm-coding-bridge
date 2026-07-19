# Reliable Multi-Model Routing and Client Setup Design

Status: approved in conversation on 2026-07-19.

## Problem

The bridge already translates OpenAI Responses and Anthropic Messages requests
to an OpenAI-compatible Chat Completions upstream. Version 0.6.3 also keeps long
ZCode streams alive and repairs several malformed streaming responses. The next
reliability gaps are structural:

- upstream errors are created and handled in several files without one stable
  classification or retry contract;
- one complete-response timeout covers connection, first content, and stream
  idle time even though those phases have different failure semantics;
- the current `upstream`/`upstreams` configuration repeats a base URL and key
  settings for every model and exposes advanced operational settings to users;
- a shared upstream endpoint may expose several models, with a different model
  ID and credential for every model;
- configuring ZCode still requires manual edits outside the bridge;
- structured logs exist, but there is no local view of route health, retry
  attempts, cooldowns, or client configuration state.

The project remains a general OpenAI-compatible coding-client bridge. Public
documentation, examples, fixtures, and built-in names must stay provider-neutral.
Private provider profiles and live credentials are external validation inputs,
not repository content.

## Goals

1. Route multiple client-visible model aliases through shared or distinct
   upstream endpoints while binding each route to its own upstream model ID and
   credential.
2. Add a single error taxonomy, phase-aware stream state, bounded same-model
   retries, backoff, and per-model cooldowns.
3. Preserve the approved safety boundary: retry only before semantic model
   content has been emitted; never replay a complete request after text,
   reasoning, refusal, or a tool call has started.
4. Replace the normal setup experience with a small guided flow while retaining
   advanced overrides and backward-compatible loading of version 1 configs.
5. Configure ZCode through a safe, idempotent client adapter so a user can open
   ZCode and select the bridge models immediately after setup.
6. Add a loopback-only local reliability console that exposes redacted runtime
   state without recording prompts, responses, tool inputs, or credentials.

## Non-Goals

- Dynamic third-party code plugins are not part of this release. Provider and
  client extension points are internal interfaces plus declarative profiles.
- Cross-model fallback is not automatic. A retry stays on the selected model
  route unless a future explicit policy is configured.
- The bridge does not store upstream keys in its main JSON configuration or in
  ZCode's provider configuration.
- The bridge does not preserve an open TCP connection while the computer is
  asleep and does not prevent system sleep.
- The bridge does not replay a request after semantic output has started, even
  when a continuation prompt might appear safe.
- The console is not a remote multi-user gateway or billing dashboard.

## Architecture

The implementation is divided into six bounded components:

1. **Configuration resolver**: loads version 1 or version 2 input and produces
   one normalized runtime configuration. Defaults, declarative profiles, and
   user overrides are resolved here only.
2. **Model route registry**: resolves a globally unique client alias to a
   provider endpoint, exact upstream model ID, credential reference, capability
   metadata, and reliability policy.
3. **Credential resolver**: loads and caches a credential by reference. Cache
   invalidation and authentication recovery are scoped to the credential used by
   one model route.
4. **Reliability runtime**: owns error classification, request phase, retry
   decisions, backoff, cooldown, and the no-replay boundary.
5. **Client adapters**: detect, plan, back up, update, verify, and roll back
   external client configuration. ZCode is the first complete adapter.
6. **Reliability event store and console**: keeps a bounded redacted event ring
   and renders local status. It never participates in request routing decisions.

Converters continue to own protocol translation. They consume a normalized
model route and reliability context instead of independently interpreting raw
configuration or transport failures.

## Configuration Model

### Version 2 user configuration

The version 2 schema groups models under their shared endpoint:

```json
{
  "version": 2,
  "providers": [
    {
      "id": "internal-provider",
      "name": "Internal Provider",
      "baseUrl": "https://api.example.com/v1",
      "models": [
        {
          "alias": "coding-fast",
          "upstreamModel": "provider-model-id-a",
          "credentialRef": "model-a",
          "capabilities": {
            "contextWindow": 131072,
            "inputModalities": ["text"],
            "reasoning": true
          }
        },
        {
          "alias": "coding-strong",
          "upstreamModel": "provider-model-id-b",
          "credentialRef": "model-b",
          "capabilities": {
            "contextWindow": 131072,
            "inputModalities": ["text"],
            "reasoning": true
          }
        }
      ]
    }
  ],
  "credentials": {
    "model-a": {
      "source": "command",
      "command": {
        "command": "/usr/bin/security",
        "args": ["find-generic-password", "-s", "llm-coding-bridge/model-a", "-w"]
      }
    },
    "model-b": {
      "source": "env",
      "env": "MODEL_B_API_KEY"
    }
  },
  "clients": {
    "zcode": {
      "enabled": true
    }
  }
}
```

Aliases are globally unique because coding clients send one model string without
a provider namespace. `upstreamModel` is the exact ID sent upstream. Every model
route must declare `credentialRef`; two routes may intentionally reference the
same credential, but the target use case supports a distinct reference per
model. Credentials support environment, direct command, and client-provided
sources. The guided macOS setup uses Keychain through the existing command source.

Capability metadata is optional in raw hand-written configuration. Missing
values receive conservative generic defaults. `setup --advanced` can collect
them, and `setup --profile <file>` can import a private declarative profile with
model metadata. Profile files are data only and cannot execute code.

### Resolution and compatibility

Resolution order is:

```text
safe built-in defaults
  -> optional declarative profile
  -> user configuration
  -> validated normalized runtime configuration
```

`config show --effective` displays the result with credential values redacted
and annotates the source of each reliability value.

Version 1 `upstream` and `upstreams` files remain readable for the whole 0.7.x
line. They are normalized in memory and are never rewritten on package install
or service start. `setup` and `config migrate` may write version 2 only after a
preview and confirmation; both create a timestamped backup before replacement.

## Credential Ownership

The bridge owns real upstream credentials in managed setup mode. The main config
stores only credential source descriptors. ZCode receives a generated local
bridge token, not an upstream key. This provides three useful boundaries:

- rotating one upstream key does not require editing ZCode;
- a leaked bridge-managed ZCode provider config cannot directly call the
  upstream;
- a 401 invalidates only the failing model route's credential cache.

The current client-provided key mode remains supported for backward
compatibility and provider switchers. It is an explicit advanced mode and is not
the default for guided ZCode setup.

Credential caches are keyed by `credentialRef`, not by provider endpoint. A 401
allows one cache invalidation and one credential reload per request. If the
refreshed credential also fails, the route is marked authentication-unavailable
and the error is not retried again.

## Request and Stream State

Every request follows this state machine:

```text
accepted
  -> connecting
  -> waiting_first_content
  -> streaming
  -> completed | failed | cancelled
```

`semanticContentStarted` becomes true on the first non-empty text, reasoning,
refusal, or tool-call delta. Bridge-generated heartbeats, protocol start events,
usage-only chunks, and empty role chunks do not set it.

One downstream stream may cover several upstream attempts while
`semanticContentStarted` is false. Its request ID remains stable, while every
upstream attempt receives an attempt number and child timing record. Once the
flag is true, any upstream failure bypasses bridge replay and closes the
downstream transport with the existing client-retry semantics.

## Error Taxonomy

All transport, HTTP, parsing, conversion, and local failures are normalized to a
`BridgeError` with these safe fields:

- `category`: `auth`, `rate_limit`, `timeout`, `network`, `upstream_5xx`,
  `protocol`, `invalid_request`, `cancelled`, or `local_config`;
- `phase`: the request state in which the failure occurred;
- `retryable`: the classifier's recommendation before policy limits;
- `scope`: request, model route, credential, provider, or local process;
- HTTP status and safe error/cause codes when available;
- model alias, request ID, attempt, and elapsed milliseconds.

Messages, prompt content, tool payloads, response bodies, authorization headers,
and credential values are excluded from the normalized object and event log.

The initial decision matrix is:

| Failure | Before semantic content | After semantic content |
|---|---|---|
| Network, DNS, TLS, connection reset | Same-model retry | Close downstream; no replay |
| Timeout | Same-model retry | Close downstream; no replay |
| HTTP 408 or 429 | Same-model retry; honor `Retry-After` | Close downstream; no replay |
| HTTP 5xx | Same-model retry | Close downstream; no replay |
| HTTP 401 | Reload this credential once, then retry | Close downstream; no replay |
| HTTP 400, 403, 404, context/parameter error | No retry | No retry |
| HTTP 200 valid non-SSE completion | Convert to SSE and complete | Not applicable |
| HTTP 200 error/invalid non-SSE body | Same-model protocol retry | Close downstream; no replay |
| Client cancellation | Cancel upstream immediately | Cancel upstream immediately |
| Local configuration error | No retry | No retry |

When an explicit upstream error must be returned before downstream headers are
committed, retain the meaningful HTTP status. When a Chat SSE response is already
committed and retry attempts are exhausted, reset the downstream connection
instead of emitting a terminal frame known to be treated as non-retryable by
some coding clients.

## Retry, Backoff, and Cooldown

The default stable policy allows three attempts total. Backoff starts at 500 ms,
uses full jitter, caps one delay at 10 seconds, and caps cumulative backoff at 30
seconds. A valid `Retry-After` value replaces the calculated delay when it fits
the remaining budget. These defaults are visible through effective config but
are not asked in normal setup.

The protocol heartbeat stays active across attempts and backoff. A real upstream
chunk resets the downstream heartbeat deadline; the heartbeat never changes
`semanticContentStarted`.

Health and cooldown state are keyed by model route. Five consecutive retryable
terminal failures open a route for 30 seconds. A route with an upstream
`Retry-After` value uses that value, capped at two minutes. After cooldown, one
half-open probe is allowed; success closes the route and resets the failure
counter. A failing probe reopens it. Failures on one route never cool down other
models that share the same base URL.

Requests arriving during cooldown wait only when the cooldown fits their
remaining retry/backoff budget; the downstream heartbeat continues during that
wait. Otherwise the bridge ends with retryable transport semantics rather than
silently selecting another model.

## Phase-Aware Timeouts

Timeouts are resolved per route from a named reliability policy. Normal setup
uses `stable`; private profiles may select `long-thinking` without adding any
provider branding to the repository.

The policies have separate values for:

- request connection and response headers;
- first upstream data after headers;
- idle time between later upstream data events;
- total non-streaming response time;
- total streaming time.

`stable` preserves the current ten-minute allowance for headers/first data and
stream idle, while disabling a total streaming deadline. `long-thinking` extends
the two pre-content deadlines to thirty minutes and also has no total streaming
deadline. Both retain the downstream 15-second protocol heartbeat. A timeout
ends only the current upstream attempt; the retry policy then applies the
semantic-content boundary and remaining attempt budget.

## Guided Setup

`llm-coding-bridge setup` replaces the long normal path through `init`. It asks
for:

1. provider display name and shared base URL;
2. one or more model aliases, exact upstream model IDs, and independent keys;
3. optional advanced capability metadata;
4. which supported clients to configure;
5. whether to install/restart the local background service;
6. whether to run a minimal real probe for one model or all models.

On macOS, managed keys are saved as separate Keychain entries and referenced by
command-backed credentials. Other platforms retain environment/command sources
until a platform credential adapter is implemented. Normal setup does not ask
about server sockets, heartbeats, response limits, retry counts, or backoff.

The existing `init`, explicit JSON, and client-provided-key workflows remain
available as advanced compatibility surfaces during 0.7.x.

## ZCode Client Adapter

The adapter contract is:

```text
detect -> plan -> backup -> apply -> verify -> rollback
```

For the currently validated ZCode 3.x layout, the provider catalog is
`~/.zcode/v2/config.json`. The adapter does not modify
`~/.zcode/cli/config.json`, which owns MCP, hooks, and plugins rather than model
providers.

The adapter writes one managed `LLM Coding Bridge` provider:

- `kind` is `openai-compatible`;
- `baseURL` is the local bridge `/v1` endpoint;
- `apiKey` is the generated local bridge token;
- the models map lists every configured client alias with capability metadata.

On first install, a random provider ID is saved in the bridge's private state
file. Subsequent runs update only that ID. If state is missing, discovery may
adopt exactly one provider whose name and local base URL match; ambiguous matches
stop with a preview instead of guessing.

The write algorithm must:

1. parse and validate the existing root and `provider` object;
2. calculate the exact field-level plan and display it in `--dry-run` mode;
3. detect whether ZCode is running and, with confirmation, quit it before apply;
4. create a timestamped backup with mode `0600`;
5. preserve all built-in, custom, and unknown provider fields outside the
   managed provider;
6. preserve a symbolic-link config path and apply the atomic update to its
   validated regular-file target instead of replacing the link itself;
7. compare the original file hash immediately before replacement and stop on a
   concurrent modification;
8. write and fsync a same-directory temporary file, validate it, atomically
   rename it, and set mode `0600`;
9. read the file back and verify the managed provider and every model alias;
10. restart ZCode only when the user approved restart.

`client remove zcode` removes only the managed provider. `client rollback zcode`
restores an explicitly selected bridge-created backup. Neither command deletes
unrelated providers or ZCode credentials.

Unknown ZCode major versions or unrecognized provider schemas are preview-only
until a tested adapter is added.

## Reliability Console

The bridge serves a small dependency-free console at `/admin` and redacted JSON
under `/admin/api/status` and `/admin/api/events`.

The console displays:

- bridge version, uptime, effective config source, and service state;
- model aliases, credential availability, last success, failure count, and
  cooldown/half-open state;
- recent request timelines with phase changes, heartbeat counts, attempts,
  backoff, safe error category, and completion state;
- detected client version, managed configuration status, and last verification;
- manual doctor actions for a selected model.

The event store is an in-memory ring of 500 events by default. It records no
prompt, response, reasoning, tool argument, header, key, or raw upstream body.
Existing redacted JSONL logs remain the durable diagnostic source. Admin routes
accept requests only from a loopback peer even when the API listener also binds
to a non-loopback address. Every state-changing doctor action additionally
requires configured local authentication.

## Commands

The target command surface is:

```text
llm-coding-bridge setup [--profile FILE] [--advanced]
llm-coding-bridge config show --effective
llm-coding-bridge config migrate [--dry-run]
llm-coding-bridge client add zcode [--dry-run]
llm-coding-bridge client remove zcode [--dry-run]
llm-coding-bridge client rollback zcode --backup FILE
llm-coding-bridge doctor --model ALIAS
llm-coding-bridge doctor --all-models
```

Every mutating command backs up user-owned configuration and prints the exact
files it changed. Non-interactive mutation requires explicit flags and never
silently restarts a client.

## Testing Strategy

Implementation follows test-driven development.

### Unit and integration tests

1. Table-test every error category, retry decision, semantic-content phase, and
   HTTP/status mapping.
2. Use one fake upstream address with several model IDs and required keys. Prove
   that every alias sends the correct ID and credential and that a 401 refreshes
   only the affected credential.
3. Cover network errors, timeouts, 408, 429 with `Retry-After`, 5xx, valid JSON
   fallback, invalid HTTP 200 JSON, exponential backoff, jitter, and exhausted
   budgets with a deterministic clock/random source.
4. Assert that heartbeats continue before the first attempt, between attempts,
   and during cooldown waits without setting semantic content.
5. Emit text, reasoning, refusal, and fragmented tool calls separately, then
   fail the upstream and prove that no case performs bridge replay.
6. Prove cooldown and half-open state isolation between models sharing one URL.
7. Test version 1 normalization, version 2 validation, explicit migration,
   secret redaction, and effective-config provenance.
8. Test ZCode writes against fixtures containing built-ins, unrelated custom
   providers, unknown fields, malformed JSON, permission differences, symlinks,
   concurrent changes, repeated setup, removal, and rollback.
9. Test admin loopback/auth boundaries, event redaction, ring eviction, and
   status rendering.

### End-to-end and live acceptance

1. Run lint, the complete test suite, security scan, secret scan, dependency
   audit, repository gate, and `npm pack --dry-run`.
2. In an isolated HOME, run setup twice and prove the bridge and ZCode configs
   are idempotent, private, valid, and recoverable from backup.
3. Start the service and verify `/health`, `/v1/models`, all configured aliases,
   one-model doctor, and all-model doctor against the fake shared endpoint.
4. Run a 20-minute fault-injection soak containing slow first content, long
   mid-stream gaps, non-SSE success, invalid HTTP 200 bodies, connection resets,
   rate limits, credential rotation, and two consecutive failures.
5. After implementation is complete, run a separate live acceptance with
   user-supplied model IDs and credentials. Live credentials and provider names
   are never committed, logged, or copied into fixtures.
6. Open/restart ZCode and confirm that every configured alias is selectable and
   can complete a real coding turn. Repeat a network interruption and macOS
   sleep/wake recovery check without claiming that the in-flight TCP connection
   survives sleep.

## Delivery Sequence

1. Introduce the normalized error type, request state, event schema, and tests
   without changing retry behavior.
2. Add version 2 model routes and credential references while retaining version
   1 loading.
3. Add bounded pre-content retry, backoff, phase timeouts, and per-route cooldown.
4. Add the generic setup flow and ZCode client adapter.
5. Add the local reliability console over the already-redacted event schema.
6. Complete automated, soak, and live ZCode validation; update generic public
   documentation; then prepare version 0.7.0 for a separate release decision.

Each delivery step must keep the full suite green and remain independently
reviewable. Publishing, tagging, and npm release occur only after live acceptance
and explicit release authorization.

## Acceptance Criteria

- Model aliases sharing one base URL always use their configured upstream model
  ID and independent credential.
- A failure, credential refresh, or cooldown on one route does not alter another
  route's health or key cache.
- Retryable failures before semantic output recover within the configured budget
  while the client receives protocol-valid heartbeat activity.
- No failure after semantic output causes complete bridge-side replay or
  duplicated text/tool calls.
- ZCode setup is idempotent, backup-first, atomic, permission-safe, and preserves
  all unrelated providers and fields.
- Opening ZCode after approved setup/restart exposes all bridge model aliases.
- The console and logs expose enough phase/attempt evidence to diagnose a failed
  turn without exposing secrets or model content.
- Version 1 configs keep working, and no install or service restart silently
  migrates user configuration.
- Public repository content remains provider-neutral.

## Alternatives Rejected

- Replacing the bridge with a general LLM gateway would not provide the required
  coding-client heartbeat, malformed-stream repair, or downstream retry
  semantics.
- Keeping one repeated upstream object per model preserves the current config
  complexity and makes per-model credentials harder to reason about.
- Letting ZCode hold the real upstream keys couples credential rotation to every
  client and leaves secrets in another application's provider catalog.
- Retrying after partial output can duplicate text, tool calls, mutations, and
  billing; continuation prompts do not make that boundary reliable enough.
- A dynamic provider plugin runtime adds versioning and security costs without
  helping the first set of declarative compatibility profiles.
