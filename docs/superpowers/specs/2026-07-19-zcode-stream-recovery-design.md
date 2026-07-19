# ZCode Stream Recovery Design

Status: approved in conversation on 2026-07-19.

## Problem

ZCode is configured as an OpenAI-compatible client for the local bridge at
`http://127.0.0.1:37629/v1`, using `glm-5.2`. The provider and model settings are
correct, and the bridge health endpoint is available. Long ZCode turns can still
end with `Model request failed` and `reason=unknown retryable=false`.

The reported failure had this sequence:

1. ZCode started the model request at 23:12:11.
2. macOS entered `Clamshell Sleep` at 23:12:33 and slept for 1060 seconds.
3. On DarkWake at 23:30:13, ZCode completed its idle watchdog with
   `stream_idle_timeout` and correctly scheduled a retry.
4. The retry started before the upstream network was ready. The bridge committed
   HTTP 200 SSE headers and emitted `Upstream request failed.` as a terminal SSE
   error frame.
5. ZCode classified that terminal frame as `unknown` and `retryable=false`, so it
   stopped after attempt 2 even though the client allows up to 11 attempts.

A separate `stream_idle_timeout` occurred without a system sleep. This shows a
second problem: bridge v0.6.1 emits SSE comment heartbeats (`: ping`) only until
the first upstream byte. SSE comments do not constitute model data events, and
the heartbeat stops during later upstream gaps.

## Required Behavior

The bridge cannot execute while macOS is in clamshell sleep and cannot preserve
an already-open TCP stream through sleep. The supported recovery contract is:

- While the Mac is awake, a streaming OpenAI Chat Completions request must emit
  protocol-valid data activity during long upstream gaps, including gaps after
  the first upstream chunk.
- If the upstream transport fails before a usable response is available, the
  bridge must expose a transport failure to ZCode instead of converting it into
  a terminal, non-retryable model error.
- After wake, ZCode must be able to continue its normal retry sequence rather
  than stopping on attempt 2.
- Logs must identify the request and failure phase without recording API keys,
  prompts, tool inputs, or response content.

Preventing clamshell sleep, changing macOS power policy, and replaying partially
consumed requests inside the bridge are out of scope. Automatic bridge-side
replay could duplicate an upstream request and its cost.

## Design

### 1. Protocol-aware chat heartbeat

Replace the OpenAI Chat Completions `: ping` comment with a protocol-valid empty
`chat.completion.chunk`. The chunk contains a stable bridge-generated ID, the
configured model, an empty delta, and `finish_reason: null`.

Keep the heartbeat active for the whole downstream stream. Real upstream chunks
touch/reset the heartbeat's idle deadline; they do not permanently stop it. The
heartbeat stops only when the response ends, the client disconnects, shutdown
terminates the stream, or a write fails.

This change is limited to the OpenAI chat path used by ZCode. Anthropic and
Responses protocol behavior remains unchanged in this patch.

### 2. Preserve retryable transport semantics

For a streaming chat request, if `fetchUpstream` throws before a usable upstream
response is available:

- stop the heartbeat;
- record a redacted transport-error log entry;
- destroy/close the downstream transport without emitting the current
  `data: {error: ...}` plus `[DONE]` terminal sequence.

ZCode already treats connection failures such as `ECONNREFUSED` as retryable and
uses its configured backoff. HTTP responses from the upstream remain status-aware
and are not silently replayed by the bridge. Client-initiated cancellation remains
a cancellation and must not create a new error response.

### 3. Redacted request diagnostics

Pass a small request context from the server into the chat converter. It may
contain only:

- `x-request-id`, `x-zcode-trace-id`, and `x-query-id` when present;
- model and route;
- phase, elapsed milliseconds, upstream HTTP status, error name, and safe error
  code/cause code.

Do not log authorization headers, API keys, request bodies, message text, tool
definitions, or response bodies. Emit one-line structured records to the existing
launchd stderr log so `llm-coding-bridge logs` remains the operator entry point.

### 4. Local installation consistency

After tests pass, set the patch version to 0.6.2, install the tested working tree
globally, restart `com.sevoniva.llm-coding-bridge`, and verify that package
metadata, loaded source hashes, health status, and launchd process all describe
the same build. Publishing or pushing a release is a separate action.

## Test Strategy

Use test-driven development.

1. Add a failing streaming test in which the upstream sends one real chunk,
   pauses beyond several heartbeat intervals, then sends a second chunk. Assert
   that protocol-valid empty data chunks occur during the gap. The current v0.6.1
   behavior must fail this test.
2. Add a failing transport test in which the upstream connection is reset before
   response headers. Assert that the downstream request ends as a network failure
   and does not receive the terminal `upstream_error` plus `[DONE]` sequence.
3. Add diagnostic tests proving request IDs and safe error codes are logged while
   credentials and request content are absent.
4. Run the focused streaming/security tests, then the complete lint and test
   suites.
5. Install and restart locally, verify `/health`, `/v1/models`, package version,
   launchd status, and source hashes.
6. Run a real ZCode multi-tool turn while the Mac remains awake. Also simulate an
   upstream disconnect and confirm ZCode advances past attempt 2. A real clamshell
   sleep may terminate the in-flight stream, but after wake it must enter retry
   rather than stop with `unknown retryable=false`.

## Alternatives Rejected

- Reinstalling v0.6.1 and keeping the lid open does not fix true mid-stream idle
  gaps or non-retryable wake failures.
- Running the always-on service under `caffeinate` would waste battery, changes
  machine-wide behavior, and does not reliably defeat clamshell sleep.
- Retrying upstream requests inside the bridge risks duplicate work and billing;
  ZCode already owns the retry policy and should receive an accurate transport
  signal.

