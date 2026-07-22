"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { validateReleaseRepository } = require("../scripts/release-gate");
const { scanRepository } = require("../scripts/security-scan");

const SHA = "0123456789abcdef0123456789abcdef01234567";

function write(root, relative, content, mode = 0o644) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function packageDocument() {
  return {
    name: "release-gate-fixture",
    version: "0.7.0",
    description: "Release gate fixture.",
    license: "MIT",
    bin: { fixture: "bin/fixture.js" },
    files: ["assets", "bin", "docs/configuration.md", "lib", "scripts", "README.md", "LICENSE"],
    scripts: {
      lint: "node --check bin/fixture.js",
      test: "node --check lib/index.js",
      "security:scan": "node scripts/security-scan.js",
      secretlint: "node --version",
      "repo:gate": "node scripts/repo-gate.js",
      "release:gate": "node scripts/release-gate.js",
      sca: "npm audit --audit-level=high --registry=https://registry.npmjs.org",
      "pack:check": "npm pack --dry-run",
      verify: "npm run lint && npm test && npm run security:scan && npm run secretlint && npm run repo:gate && npm run release:gate && npm run sca && npm run pack:check",
      "test:soak": "node scripts/fault-soak.js --duration-ms 1200000 --seed 7070 --report .artifacts/fault-soak.json",
    },
    engines: { node: ">=18" },
    repository: { type: "git", url: "https://example.invalid/release-gate-fixture.git" },
  };
}

function safeWorkflow(name) {
  if (name === "ci.yml") {
    return `name: CI\non: [push]\njobs:\n  test:\n    strategy:\n      matrix:\n        node: [18, 20, 22, 24]\n    steps:\n      - uses: actions/checkout@${SHA}\n      - uses: actions/setup-node@${SHA}\n      - run: npm run verify\n`;
  }
  if (name === "publish.yml") {
    return `name: Publish\non: [push]\njobs:\n  publish:\n    steps:\n      - uses: actions/checkout@${SHA}\n      - run: test "$GITHUB_REF_NAME" = "v$(node -p \"require('./package.json').version\")"\n      - run: npm run verify\n      - run: npm pack --dry-run\n      - run: npm publish --provenance --access public\n`;
  }
  if (name === "security.yml") {
    return `name: Security\non: [push]\njobs:\n  semgrep:\n    steps:\n      - uses: actions/checkout@${SHA}\n  osv:\n    steps:\n      - uses: actions/checkout@${SHA}\n  secretlint:\n    steps:\n      - uses: actions/checkout@${SHA}\n`;
  }
  return `name: ${name}\non: [push]\njobs:\n  check:\n    steps:\n      - uses: actions/checkout@${SHA}\n`;
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-release-gate-"));
  write(root, "package.json", `${JSON.stringify(packageDocument(), null, 2)}\n`);
  write(root, "package-lock.json", `${JSON.stringify({
    name: "release-gate-fixture",
    version: "0.7.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "release-gate-fixture", version: "0.7.0" } },
  }, null, 2)}\n`);
  write(root, "README.md", "# Release Gate Fixture\n\nProvider-neutral documentation.\n");
  write(root, "LICENSE", "Fixture license.\n");
  write(root, ".gitignore", "node_modules/\n*.tgz\n.artifacts/\n");
  write(root, ".secretlintrc.json", "{}\n");
  write(root, ".secretlintignore", "node_modules\n");
  write(root, "docs/configuration.md", "# Configuration\n\nGeneric configuration.\n");
  write(root, "docs/release-checklist.md", "# Release Checklist\n");
  write(root, "bin/fixture.js", "#!/usr/bin/env node\n\"use strict\";\nrequire(\"../lib/index\");\n", 0o755);
  write(root, "lib/index.js", "\"use strict\";\nmodule.exports = { ok: true };\n");
  write(root, "assets/admin/index.html", "<!doctype html><link rel=\"stylesheet\" href=\"/admin/admin.css\"><main></main><script src=\"/admin/admin.js\" defer></script>\n");
  write(root, "assets/admin/admin.css", "body { color: #111; }\n");
  write(root, "assets/admin/admin.js", "\"use strict\";\ndocument.querySelector(\"main\").textContent = \"ready\";\n");
  write(root, "scripts/fault-soak.js", "\"use strict\";\n");
  write(root, "scripts/release-gate.js", "\"use strict\";\n");
  write(root, "scripts/repo-gate.js", "\"use strict\";\n");
  write(root, "scripts/security-scan.js", "\"use strict\";\n");
  for (const name of ["ci.yml", "codeql.yml", "security.yml", "publish.yml"]) {
    write(root, `.github/workflows/${name}`, safeWorkflow(name));
  }
  return root;
}

function findings(root) {
  return scanRepository(root).map((finding) => finding.id);
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const root = createFixture();
try {
  assert.deepEqual(findings(root), []);
  assert.doesNotThrow(() => validateReleaseRepository(root));

  const ciPath = path.join(root, ".github/workflows/ci.yml");
  const safeCi = fs.readFileSync(ciPath, "utf8");
  fs.writeFileSync(ciPath, safeCi.replace(`actions/checkout@${SHA}`, "actions/checkout@v4"));
  assert.throws(() => validateReleaseRepository(root), /full commit SHA/i);
  fs.writeFileSync(ciPath, safeCi);

  fs.writeFileSync(ciPath, safeCi.replace("node: [18, 20, 22, 24]", "node: [24]"));
  assert.throws(() => validateReleaseRepository(root), /Node 18, 20, 22, and 24/i);
  fs.writeFileSync(ciPath, safeCi);

  const publishPath = path.join(root, ".github/workflows/publish.yml");
  const safePublish = fs.readFileSync(publishPath, "utf8");
  fs.writeFileSync(publishPath, safePublish.replace("npm publish --provenance --access public", "npm publish"));
  assert.throws(() => validateReleaseRepository(root), /provenance.*public access/i);
  fs.writeFileSync(publishPath, safePublish);

  const safePackage = packageDocument();
  const incompletePackage = packageDocument();
  incompletePackage.scripts.verify = "npm test";
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(incompletePackage, null, 2)}\n`);
  assert.throws(() => validateReleaseRepository(root), /verify script/i);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(safePackage, null, 2)}\n`);

  assert.throws(() => validateReleaseRepository(root, { tag: "v0.6.9" }), /tag.*version/i);

  const safeLibrary = fs.readFileSync(path.join(root, "lib/index.js"), "utf8");
  write(root, "lib/index.js", `const token = "${"sk-" + "A".repeat(32)}";\n`);
  assert.ok(findings(root).includes("secret-api-key"));
  write(root, "lib/index.js", safeLibrary);

  write(root, "lib/index.js", `require("node:child_process").spawnSync("tool", [], { ${"shell" + ": true"} });\n`);
  assert.ok(findings(root).includes("shell-enabled-process"));
  write(root, "lib/index.js", safeLibrary);

  write(root, "lib/index.js", `${"e" + "val"}(\"1 + 1\");\nnew ${"Fun" + "ction"}(\"return 1\")();\n`);
  assert.deepEqual(findings(root).filter((id) => id === "dynamic-code").length, 2);
  write(root, "lib/index.js", safeLibrary);

  write(root, "assets/admin/admin.js", "document.querySelector(\"main\").innerHTML = location.hash;\n");
  assert.ok(findings(root).includes("unsafe-admin-dom"));
  write(root, "assets/admin/admin.js", "document.querySelector(\"main\").textContent = \"ready\";\n");

  write(root, "assets/admin/index.html", "<!doctype html><script src=\"https://cdn.example.invalid/admin.js\"></script>\n");
  assert.ok(findings(root).includes("remote-admin-asset"));
  write(root, "assets/admin/index.html", "<!doctype html><link rel=\"stylesheet\" href=\"/admin/admin.css\"><main></main><script src=\"/admin/admin.js\" defer></script>\n");

  write(root, "test/helper.js", "\"use strict\";\n");
  write(root, "scripts/fault-soak.js", "\"use strict\";\nrequire(\"../test/helper\");\n");
  assert.throws(() => validateReleaseRepository(root), /packaged relative dependency/i);
  write(root, "scripts/fault-soak.js", "\"use strict\";\n");

  const secretFixture = write(root, "fixtures/live-secret.json", `{"token":"${"sk-" + "B".repeat(32)}"}\n`, 0o644);
  assert.throws(() => validateReleaseRepository(root), /secret-bearing file.*0600/i);
  fs.unlinkSync(secretFixture);

  const privateTerms = write(root, "private-terms.txt", "PrivateVendor\n");
  fs.appendFileSync(path.join(root, "README.md"), "PrivateVendor\n");
  assert.throws(() => validateReleaseRepository(root, { privateTermsFile: privateTerms }), /private public term/i);
  write(root, "README.md", "# Release Gate Fixture\n\nProvider-neutral documentation.\n");
  fs.unlinkSync(privateTerms);

  git(root, ["init", "-b", "main"]);
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Release Gate", "-c", "user.email=release@example.invalid", "commit", "-m", "fixture"]);
  assert.doesNotThrow(() => validateReleaseRepository(root, { release: true, tag: "v0.7.0" }));
  fs.appendFileSync(path.join(root, "README.md"), "dirty\n");
  assert.throws(() => validateReleaseRepository(root, { release: true, tag: "v0.7.0" }), /dirty release worktree/i);

  console.log("release gate tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
