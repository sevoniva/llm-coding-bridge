"use strict";

const fs = require("node:fs");

const requiredFiles = [
  "README.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
  ".gitignore",
  ".github/workflows/ci.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/security.yml",
  ".github/workflows/publish.yml",
];

const missing = requiredFiles.filter((file) => !fs.existsSync(file));
if (missing.length) {
  console.error(`Missing required files: ${missing.join(", ")}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
for (const field of ["name", "version", "description", "license", "repository", "bin", "files"]) {
  if (!pkg[field]) {
    console.error(`Missing package.json field: ${field}`);
    process.exit(1);
  }
}

console.log("Repository gate passed.");
