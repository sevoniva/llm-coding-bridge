"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set([".git", "node_modules"]);
const SCANNED_EXTENSIONS = new Set([".js", ".json", ".md", ".toml", ".yml", ".yaml", ".env"]);

const checks = [
  {
    id: "secret-token",
    message: "Possible hard-coded token.",
    pattern: new RegExp("\\b(?:ghp|github_pat|npm)_[A-Za-z0-9_=-]{16,}\\b"),
  },
  {
    id: "secret-sk",
    message: "Possible hard-coded API key.",
    pattern: new RegExp("\\bsk-[A-Za-z0-9]{16,}\\b"),
  },
  {
    id: "eval",
    message: "Avoid eval for request or configuration handling.",
    pattern: /\beval\s*\(/,
  },
  {
    id: "new-function",
    message: "Avoid dynamic Function construction.",
    pattern: /\bnew\s+Function\s*\(/,
  },
  {
    id: "child-process-exec",
    message: "Avoid shell-based child_process exec APIs.",
    pattern: /\bexec(?:File)?(?:Sync)?\s*\(/,
  },
  {
    id: "shell-true",
    message: "Avoid enabling a shell for child_process calls.",
    pattern: /\bshell\s*:\s*true\b/,
  },
];

function listFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "package-lock.json") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...listFiles(fullPath));
      continue;
    }
    if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

function lineNumber(text, index) {
  return text.slice(0, index).split("\n").length;
}

const findings = [];
for (const file of listFiles(ROOT)) {
  const relative = path.relative(ROOT, file);
  const text = fs.readFileSync(file, "utf8");
  for (const check of checks) {
    const index = text.search(check.pattern);
    if (index >= 0) findings.push({ file: relative, line: lineNumber(text, index), ...check });
  }
}

if (findings.length) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line} [${finding.id}] ${finding.message}`);
  }
  process.exitCode = 1;
} else {
  console.log("Security scan passed.");
}
