#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { validateRepository } = require("./repo-gate");

const SECRET_PATTERNS = [
  /\b(?:ghp|github_pat|npm)_[A-Za-z0-9_=-]{16,}\b/,
  new RegExp("\\bsk-[A-Za-z0-9]{16,}\\b"),
];
const PUBLIC_FILES = ["README.md", "package.json", "docs/configuration.md"];
const PUBLIC_DIRECTORIES = ["assets/admin", "docs/releases", "examples", "templates"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "command failed").trim();
    throw new Error(`${options.label || command} failed${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout || "");
}

function listFiles(directory, options = {}) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if ([".git", "node_modules", ".artifacts"].includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath, options));
    else if (entry.isFile() && (!options.extensions || options.extensions.has(path.extname(entry.name)))) files.push(fullPath);
  }
  return files;
}

function packageManifest(rootDirectory) {
  const output = run("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"], {
    cwd: rootDirectory,
    label: "npm pack --dry-run",
  });
  let manifest;
  try {
    manifest = JSON.parse(output)[0];
  } catch {
    throw new Error("npm pack --dry-run returned invalid JSON.");
  }
  if (!manifest || !Array.isArray(manifest.files)) throw new Error("npm pack --dry-run returned no file manifest.");
  return manifest;
}

function resolveRelativeModule(rootDirectory, source, request) {
  const base = path.resolve(path.dirname(source), request);
  const candidates = [base, `${base}.js`, path.join(base, "index.js")];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || null;
}

function relativeRequires(file) {
  const source = fs.readFileSync(file, "utf8");
  const requests = [];
  const pattern = /\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) requests.push(match[1]);
  return requests;
}

function validatePackage(rootDirectory, pkg) {
  const manifest = packageManifest(rootDirectory);
  const packaged = new Set(manifest.files.map((entry) => entry.path.replaceAll(path.sep, "/")));
  const required = ["package.json", "README.md", "LICENSE", ...Object.values(pkg.bin || {})];
  for (const relative of ["docs/configuration.md", "assets/admin/index.html", "assets/admin/admin.css", "assets/admin/admin.js"]) {
    if (fs.existsSync(path.join(rootDirectory, relative))) required.push(relative);
  }
  const missing = required.filter((relative) => !packaged.has(relative.replaceAll(path.sep, "/")));
  if (missing.length) throw new Error(`Missing packaged files: ${missing.join(", ")}`);

  for (const relative of packaged) {
    if (!/\.c?js$/.test(relative)) continue;
    const source = path.join(rootDirectory, relative);
    if (!fs.existsSync(source)) continue;
    for (const request of relativeRequires(source)) {
      const target = resolveRelativeModule(rootDirectory, source, request);
      if (!target) throw new Error(`Packaged relative dependency does not exist: ${relative} -> ${request}`);
      const targetRelative = path.relative(rootDirectory, target).replaceAll(path.sep, "/");
      if (!packaged.has(targetRelative)) {
        throw new Error(`Packaged relative dependency is missing: ${relative} -> ${targetRelative}`);
      }
    }
  }
  return manifest;
}

function validateVersions(rootDirectory, pkg, tag) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version || "")) throw new Error("package version is invalid.");
  const lock = JSON.parse(fs.readFileSync(path.join(rootDirectory, "package-lock.json"), "utf8"));
  if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
    throw new Error("package.json and package-lock.json versions do not match.");
  }
  if (tag && tag !== `v${pkg.version}`) throw new Error(`Release tag ${tag} does not match package version ${pkg.version}.`);
}

function containsSecret(text) {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

function validateSecretFileModes(rootDirectory) {
  for (const file of listFiles(rootDirectory)) {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o077) === 0 || stat.size > 2 * 1024 * 1024) continue;
    let text;
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    if (containsSecret(text)) {
      throw new Error(`Secret-bearing file must use mode 0600: ${path.relative(rootDirectory, file)}`);
    }
  }
}

function publicFiles(rootDirectory) {
  const files = PUBLIC_FILES.map((relative) => path.join(rootDirectory, relative)).filter(fs.existsSync);
  for (const relative of PUBLIC_DIRECTORIES) files.push(...listFiles(path.join(rootDirectory, relative)));
  return files;
}

function loadPrivateTerms(file) {
  if (!file) return [];
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Private terms file must be a regular file no larger than 64 KiB.");
  return fs.readFileSync(file, "utf8").split(/\r?\n/).map((term) => term.trim()).filter((term) => term && !term.startsWith("#"));
}

function validatePublicTerms(rootDirectory, privateTermsFile) {
  const terms = loadPrivateTerms(privateTermsFile);
  if (!terms.length) return;
  for (const file of publicFiles(rootDirectory)) {
    const text = fs.readFileSync(file, "utf8").toLowerCase();
    const term = terms.find((candidate) => text.includes(candidate.toLowerCase()));
    if (term) throw new Error(`Private public term found in ${path.relative(rootDirectory, file)}.`);
  }
}

function validateReleaseGitState(rootDirectory) {
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: rootDirectory, label: "git status" });
  if (status.trim()) throw new Error("Dirty release worktree is not allowed.");
  const branch = run("git", ["branch", "--show-current"], { cwd: rootDirectory, label: "git branch" }).trim();
  if (branch) {
    if (branch !== "main") throw new Error(`Release must run from main, not ${branch}.`);
    return;
  }
  const contains = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], {
    cwd: rootDirectory,
    encoding: "utf8",
    shell: false,
  });
  if (contains.status !== 0) throw new Error("Detached release commit is not contained in origin/main.");
}

function validateReleaseRepository(rootDirectory = process.cwd(), options = {}) {
  const root = path.resolve(rootDirectory);
  validateRepository(root);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const tag = options.tag || (options.release ? process.env.GITHUB_REF_NAME : "");
  validateVersions(root, pkg, tag);
  validateSecretFileModes(root);
  validatePublicTerms(root, options.privateTermsFile || process.env.LLM_BRIDGE_PRIVATE_TERMS_FILE);
  const manifest = validatePackage(root, pkg);
  if (options.release) {
    if (!tag) throw new Error("Release tag is required.");
    validateReleaseGitState(root);
  }
  return { manifest, version: pkg.version, tag: tag || null };
}

function parseArgs(argv) {
  const options = { root: process.cwd(), release: false, tag: "", privateTermsFile: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--release") options.release = true;
    else if (["--root", "--tag", "--private-terms-file"].includes(name)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${name} requires a value.`);
      if (name === "--root") options.root = value;
      if (name === "--tag") options.tag = value;
      if (name === "--private-terms-file") options.privateTermsFile = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${name}`);
  }
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = validateReleaseRepository(options.root, options);
    console.log(`Release gate passed for ${result.version}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArgs, validateReleaseRepository };
