"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { powershellPath, powershellArgs } = require("../lib/windows");

if (process.platform === "win32") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-private-native-"));
  const file = path.join(directory, "empty.json");
  const descriptor = fs.openSync(file, "wx");
  try {
    // This fixture contains no credentials; retain native diagnostics on failure.
    for (const action of ["ProtectFile", "VerifyFile"]) {
      const result = spawnSync(powershellPath(), powershellArgs("windows-security.ps1", ["-Action", action, "-File", file]), {
        encoding: "utf8", shell: false, windowsHide: true, timeout: 30000,
      });
      assert.equal(result.status, 0, `${action}: ${result.stderr || result.error?.message || result.stdout}`);
    }
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log("Windows private-file subprocess tests passed");
}
