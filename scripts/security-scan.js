"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CODE_ROOTS = ["bin", "lib", "scripts", "test"];
const CODE_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const ADMIN_EXTENSIONS = new Set([".js", ".css", ".html"]);

const RULES = [
  {
    id: "secret-token",
    message: "Possible hard-coded token.",
    pattern: /\b(?:ghp|github_pat|npm)_[A-Za-z0-9_=-]{16,}\b/,
  },
  {
    id: "secret-api-key",
    message: "Possible hard-coded API key.",
    pattern: /\bsk-[A-Za-z0-9]{16,}\b/,
  },
  {
    id: "dynamic-code",
    message: "Avoid eval for request or configuration handling.",
    pattern: /\beval\s*\(/,
  },
  {
    id: "dynamic-code",
    message: "Avoid dynamic Function construction.",
    pattern: /\bnew\s+Function\s*\(/,
  },
  {
    id: "child-process-exec",
    message: "Avoid shell-based child_process exec APIs.",
    pattern: new RegExp("(?:\\b(?:child_process|childProcess|cp)\\s*\\.\\s*|(?<![\\w.]))e" + "xec(?:File)?(?:Sync)?\\s*\\("),
  },
  {
    id: "shell-enabled-process",
    message: "Avoid enabling a shell for child_process calls.",
    pattern: /\bshell\s*:\s*true\b/,
  },
  {
    id: "path-traversal-source",
    message: "Do not pass request-derived paths directly to filesystem operations.",
    pattern: /\b(?:readFile|writeFile|open|createReadStream|createWriteStream)(?:Sync)?\s*\(\s*(?:req(?:uest)?\.|user(?:Path|File|Input)\b|input(?:Path|File)\b)/,
  },
];

const ADMIN_RULES = [
  {
    id: "unsafe-admin-dom",
    message: "Admin assets must not insert untrusted HTML.",
    pattern: /(?:\.(?:innerHTML|outerHTML)\s*=|\binsertAdjacentHTML\s*\(|\bdocument\.write\s*\()/,
  },
  {
    id: "remote-admin-asset",
    message: "Admin assets must not load remote content.",
    pattern: /(?:https?:\/\/|\/\/[^/\s"']+\.[^/\s"']+)/i,
  },
];

function listFiles(directory, extensions) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath, extensions));
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

function suppressed(line, ruleId) {
  return line.includes(`security-scan-allow:${ruleId}`);
}

function scanFile(file, rootDirectory, rules) {
  const findings = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(line) && !suppressed(line, rule.id)) {
        findings.push({
          id: rule.id,
          message: rule.message,
          file: path.relative(rootDirectory, file),
          line: index + 1,
        });
      }
    }
  });
  return findings;
}

function scanRepository(rootDirectory = process.cwd()) {
  const root = path.resolve(rootDirectory);
  const findings = [];
  for (const relative of CODE_ROOTS) {
    for (const file of listFiles(path.join(root, relative), CODE_EXTENSIONS)) {
      findings.push(...scanFile(file, root, RULES));
    }
  }
  for (const file of listFiles(path.join(root, "assets", "admin"), ADMIN_EXTENSIONS)) {
    findings.push(...scanFile(file, root, [...RULES, ...ADMIN_RULES]));
  }
  return findings.sort((left, right) => (
    left.file.localeCompare(right.file) || left.line - right.line || left.id.localeCompare(right.id)
  ));
}

function main() {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, "..");
  const findings = scanRepository(root);
  if (findings.length) {
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line} [${finding.id}] ${finding.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("Security scan passed.");
}

if (require.main === module) main();

module.exports = { scanRepository };
