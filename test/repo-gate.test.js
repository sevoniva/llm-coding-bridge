"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findWorkflowUseViolations } = require("../scripts/repo-gate");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "repo-gate-test-"));
const workflowDirectory = path.join(temporaryDirectory, ".github", "workflows");
fs.mkdirSync(workflowDirectory, { recursive: true });

try {
  const workflowPath = path.join(workflowDirectory, "actions.yml");
  const dockerDigest = "a".repeat(64);
  fs.writeFileSync(workflowPath, [
    "steps:",
    "  - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6",
    "  - uses: ./local-action",
    `  - uses: docker://alpine@sha256:${dockerDigest}`,
    "  - uses: docker://alpine:3.20",
    "  - uses: actions/checkout@v6",
    "  - uses: actions/checkout@main",
    "  - uses: actions/checkout@${{ github.ref }}",
    "  - { name: Mutable flow action, uses: actions/checkout@v6 }",
    "  - { name: Pinned flow action, uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 }",
    "",
  ].join("\n"));

  const violations = findWorkflowUseViolations(workflowDirectory, temporaryDirectory);
  assert.deepEqual(
    violations.map(({ line, value }) => ({ line, value })),
    [
      { line: 5, value: "docker://alpine:3.20" },
      { line: 6, value: "actions/checkout@v6" },
      { line: 7, value: "actions/checkout@main" },
      { line: 8, value: "actions/checkout@${{ github.ref }}" },
      { line: 9, value: "actions/checkout@v6" },
    ],
  );
  assert.equal(violations.every(({ file }) => file === ".github/workflows/actions.yml"), true);

  fs.writeFileSync(
    path.join(workflowDirectory, "pinned.yaml"),
    "jobs:\n  reusable:\n    uses: owner/repository/workflow@0123456789abcdef0123456789abcdef01234567\n",
  );
  assert.equal(findWorkflowUseViolations(workflowDirectory, temporaryDirectory).length, 5);

  console.log("Repository gate tests passed.");
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
