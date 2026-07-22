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

Status: pending full 20-minute execution.
