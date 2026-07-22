"use strict";

const fs = require("node:fs");
const path = require("node:path");

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
  ".secretlintignore",
  ".secretlintrc.json",
  "assets/admin/admin.css",
  "assets/admin/admin.js",
  "assets/admin/index.html",
  "docs/configuration.md",
  "docs/release-checklist.md",
  "scripts/fault-soak.js",
  "scripts/release-gate.js",
  "scripts/repo-gate.js",
  "scripts/security-scan.js",
];

const requiredScripts = [
  "lint",
  "security:scan",
  "secretlint",
  "repo:gate",
  "release:gate",
  "sca",
  "test",
  "test:soak",
  "verify",
  "pack:check",
];
const verifyCommands = [
  "npm run lint",
  "npm test",
  "npm run security:scan",
  "npm run secretlint",
  "npm run repo:gate",
  "npm run release:gate",
  "npm run sca",
  "npm run pack:check",
];

const pinnedActionPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/;
const pinnedDockerPattern = /^docker:\/\/[^\s]+@sha256:[0-9a-f]{64}$/;

function listWorkflowFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listWorkflowFiles(entryPath);
      }
      return /\.ya?ml$/i.test(entry.name) ? [entryPath] : [];
    });
}

function readUsesValue(line) {
  const match = line.match(/^\s*(?:-\s*)?uses\s*:\s*(.*?)\s*$/);
  if (!match) {
    return null;
  }

  let value = match[1].replace(/\s+#.*$/, "").trim();
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function readFlowUsesValues(line) {
  const values = [];
  const pattern = /(?:[{,])\s*uses\s*:\s*(?:"([^"]*)"|'([^']*)'|([^,}]+))/g;
  for (const match of line.matchAll(pattern)) {
    values.push((match[1] ?? match[2] ?? match[3]).trim());
  }
  return values;
}

function readUsesValues(line) {
  const value = readUsesValue(line);
  return value === null ? readFlowUsesValues(line) : [value];
}

function violationRequirement(value) {
  if (value.startsWith("./")) return null;
  if (value.startsWith("docker://")) {
    return pinnedDockerPattern.test(value)
      ? null
      : "Docker action must use an immutable sha256 digest";
  }
  return pinnedActionPattern.test(value)
    ? null
    : "external action must use a full commit SHA";
}

function findWorkflowUseViolations(workflowDirectory, rootDirectory = process.cwd()) {
  const violations = [];
  for (const workflowPath of listWorkflowFiles(workflowDirectory)) {
    const lines = fs.readFileSync(workflowPath, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const value of readUsesValues(line)) {
        const requirement = violationRequirement(value);
        if (!requirement) continue;
        violations.push({
          file: path.relative(rootDirectory, workflowPath) || path.basename(workflowPath),
          line: index + 1,
          value,
          requirement,
        });
      }
    });
  }
  return violations;
}

function requireText(text, pattern, message) {
  if (!pattern.test(text)) throw new Error(message);
}

function validatePackageScripts(pkg) {
  if (!pkg.scripts || typeof pkg.scripts !== "object") throw new Error("Missing package scripts.");
  const missing = requiredScripts.filter((name) => typeof pkg.scripts[name] !== "string" || !pkg.scripts[name].trim());
  if (missing.length) throw new Error(`Missing package scripts: ${missing.join(", ")}`);
  const absentVerifyCommands = verifyCommands.filter((command) => !pkg.scripts.verify.includes(command));
  if (absentVerifyCommands.length) throw new Error(`verify script is incomplete: ${absentVerifyCommands.join(", ")}`);
  if (!/--duration-ms\s+1200000\b/.test(pkg.scripts["test:soak"]) || !/--report\s+\S+/.test(pkg.scripts["test:soak"])) {
    throw new Error("test:soak must run for 1,200,000 ms and retain a report.");
  }
}

function validateWorkflowContracts(rootDirectory) {
  const ci = fs.readFileSync(path.join(rootDirectory, ".github", "workflows", "ci.yml"), "utf8");
  const matrixLine = ci.split(/\r?\n/).find((line) => /^\s*node\s*:\s*\[/.test(line));
  const versions = new Set((matrixLine?.match(/\d+/g) || []).map(Number));
  if (![18, 20, 22, 24].every((version) => versions.has(version))) {
    throw new Error("CI must test Node 18, 20, 22, and 24.");
  }
  requireText(ci, /\brun:\s*npm run verify\b/, "CI must run the complete npm verify gate.");

  const publish = fs.readFileSync(path.join(rootDirectory, ".github", "workflows", "publish.yml"), "utf8");
  requireText(publish, /GITHUB_REF_NAME/, "Publish workflow must compare the tag to package version.");
  requireText(publish, /package\.json[^\n]*version|require\(['"]\.\/package\.json['"]\)\.version/, "Publish workflow must read package version.");
  requireText(publish, /\brun:\s*npm run verify\b/, "Publish workflow must run npm verify.");
  requireText(publish, /npm (?:run pack:check|pack --dry-run)/, "Publish workflow must run a dry pack check.");
  requireText(publish, /npm publish[^\n]*--provenance[^\n]*--access\s+public/, "Publish workflow must use provenance and public access.");

  const security = fs.readFileSync(path.join(rootDirectory, ".github", "workflows", "security.yml"), "utf8");
  for (const name of ["semgrep", "osv", "secretlint"]) {
    if (!security.toLowerCase().includes(name)) throw new Error(`Security workflow must run ${name}.`);
  }
}

function validateRepository(rootDirectory = process.cwd()) {
  const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(rootDirectory, file)));
  if (missing.length) {
    throw new Error(`Missing required files: ${missing.join(", ")}`);
  }

  const packagePath = path.join(rootDirectory, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  for (const field of ["name", "version", "description", "license", "repository", "bin", "files"]) {
    if (!pkg[field]) {
      throw new Error(`Missing package.json field: ${field}`);
    }
  }
  validatePackageScripts(pkg);
  validateWorkflowContracts(rootDirectory);

  const violations = findWorkflowUseViolations(
    path.join(rootDirectory, ".github", "workflows"),
    rootDirectory,
  );
  if (violations.length) {
    const details = violations
      .map(({ file, line, value, requirement }) => `${file}:${line}: ${requirement}: ${value}`)
      .join("\n");
    throw new Error(`Unpinned GitHub Actions references:\n${details}`);
  }
}

function main() {
  try {
    validateRepository();
    console.log("Repository gate passed.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  findWorkflowUseViolations,
  readUsesValue,
  readUsesValues,
  validatePackageScripts,
  validateRepository,
  validateWorkflowContracts,
};
