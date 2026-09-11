"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function check(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) check(file);
    else if (entry.name.endsWith(".js")) {
      const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit", shell: false });
      if (result.error || result.status !== 0) process.exitCode = 1;
    }
  }
}
for (const directory of ["bin", "lib", "test", "scripts", "assets/admin"]) check(path.join(__dirname, "..", directory));
