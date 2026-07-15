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
  validateRepository,
};
