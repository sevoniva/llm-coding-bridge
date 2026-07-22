# v0.7 Release Checklist

This checklist records release evidence without credentials, prompts, completion content, private provider identifiers, endpoints, trace IDs, session IDs, or machine-specific paths.

## Automated Reliability Soak

- Command: `npm run test:soak`
- Required wall-clock duration: at least 1,200,000 ms (20 minutes)
- Deterministic seed: `7070`
- Report: `.artifacts/fault-soak.json`
- Development smoke: `node scripts/fault-soak.js --duration-ms 3000 --seed 7070 --report /tmp/llm-coding-bridge-soak.json`

The release run must report `ok: true`, cover every configured fault, and show successful requests and recoveries for every alias. All of these counters must remain zero:

- semantic replay
- leaked secret
- alias, upstream model, or credential mismatch
- event-ring overflow beyond capacity
- success during an ineligible route cooldown
- missing downstream heartbeat beyond two intervals plus 500 ms
- leaked referenced socket, timer, or listening server
- unexplained terminal failure
- unhandled rejection or exception

The full run uses real 20-second mid-stream gaps. Short mode scales long waits only to make the deterministic schema and state-machine smoke suitable for normal tests.

Before starting, the runner deletes any report at the requested path. A completed run writes a new private report. An interrupted run is not evidence: the report remains absent and the full command must be restarted from the beginning.

Status: not executed before the expedited release; the deterministic short-mode soak and its interruption cleanup test passed. This is a recorded validation gap, not a passed full-soak result.

## Automated Fast Gate

- Date: 2026-07-22
- Runtime: Node.js `v22.22.0`, npm `10.9.4`
- `node test/chat-compat.test.js`: passed, including empty assistant history cleanup and semantic payload preservation.
- `npm run verify`: passed after the dependency lock was updated to the fixed `fast-uri` `3.1.4`.
- Dependency audit: zero known vulnerabilities at the configured high-severity threshold.
- Static source scan, secretlint, repository gate, release gate, complete test suite, and dry-run package manifest: passed.

## Expedited Release Exceptions

The following gates were explicitly skipped to complete an expedited release. They must not be represented as passed:

- Codex Security interactive repository scan: canceled before analysis.
- Full 1,200,000 ms soak: not run.
- Real three-model credential, protocol, ZCode turn, network interruption, and macOS sleep/wake acceptance: not run.

The deterministic fake-upstream matrix still covers three aliases, independent credentials, Chat/Responses/Anthropic protocols, credential refresh, 429/503 responses, malformed success bodies, slow and idle streams, transport resets, cooldown isolation, redaction, and alias boundaries.
