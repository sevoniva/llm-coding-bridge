"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const assetDirectory = path.join(root, "assets", "admin");
const paths = {
  html: path.join(assetDirectory, "index.html"),
  css: path.join(assetDirectory, "admin.css"),
  js: path.join(assetDirectory, "admin.js"),
};

for (const [name, file] of Object.entries(paths)) {
  assert.equal(fs.existsSync(file), true, `${name} asset must exist`);
}

const html = fs.readFileSync(paths.html, "utf8");
const css = fs.readFileSync(paths.css, "utf8");
const javascript = fs.readFileSync(paths.js, "utf8");

assert.equal((html.match(/<main\b/g) || []).length, 1);
assert.match(html, /<h1\b[^>]*>[^<]+<\/h1>/);
assert.ok((html.match(/<h2\b/g) || []).length >= 3);
assert.match(html, /aria-live="polite"/);
assert.match(html, /id="routes-body"/);
assert.match(html, /id="event-timeline"/);
assert.match(html, /id="doctor-all"/);
assert.match(html, /<label\b[^>]*for="admin-token"/);
assert.match(html, /<input\b[^>]*id="admin-token"[^>]*type="password"/);
assert.match(html, /<link\b[^>]*href="\/admin\/admin\.css"/);
assert.match(html, /<script\b[^>]*src="\/admin\/admin\.js"[^>]*defer/);
assert.doesNotMatch(html, /<(?:style|script)(?:\s|>)(?![^>]*src=)/i);
assert.doesNotMatch(html, /https?:\/\//i);
assert.doesNotMatch(html, /\son[a-z]+\s*=/i);

assert.match(javascript, /\.textContent\s*=/);
assert.match(javascript, /visibilitychange/);
assert.match(javascript, /document\.hidden/);
assert.match(javascript, /AbortController/);
assert.match(javascript, /afterSequence/);
assert.match(javascript, /5000/);
assert.doesNotMatch(javascript, /\.innerHTML\s*=/);
assert.doesNotMatch(javascript, /\beval\s*\(/);
assert.doesNotMatch(javascript, /\bnew\s+Function\s*\(/);
assert.doesNotMatch(javascript, /https?:\/\//i);
assert.doesNotMatch(javascript, /localStorage|sessionStorage|indexedDB/);
const doctorFunction = javascript.indexOf("async function runDoctor");
const doctorRefresh = javascript.indexOf("await poll();", doctorFunction);
const doctorResultNotice = javascript.indexOf("failures.length ? `${failures.length} probe failed`", doctorFunction);
assert.ok(doctorFunction >= 0 && doctorRefresh > doctorFunction);
assert.ok(doctorResultNotice > doctorRefresh, "doctor result notice must remain visible after refresh");
const pollFunction = javascript.slice(javascript.indexOf("async function poll"), doctorFunction);
assert.doesNotMatch(pollFunction, /showNotice\(""\)/, "successful polling must not clear doctor notices");

assert.match(css, /prefers-color-scheme:\s*dark/);
assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.match(css, /@media[^\{]*max-width:\s*\d+px/);
assert.match(css, /min-width:\s*0/);
assert.match(css, /html\s*\{[^}]*overflow-x:\s*clip/s);
assert.match(css, /\.notice\[data-tone="error"\]/);
assert.doesNotMatch(css, /letter-spacing:\s*-/);
assert.doesNotMatch(css, /linear-gradient|radial-gradient|conic-gradient/);
assert.doesNotMatch(css, /url\s*\(/i);

const syntax = spawnSync(process.execPath, ["--check", paths.js], { encoding: "utf8" });
assert.equal(syntax.status, 0, syntax.stderr || syntax.stdout);

const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
});
assert.equal(packed.status, 0, packed.stderr || packed.stdout);
const manifest = JSON.parse(packed.stdout)[0];
const packagedFiles = manifest.files.map((entry) => entry.path);
for (const file of ["assets/admin/index.html", "assets/admin/admin.css", "assets/admin/admin.js"]) {
  assert.ok(packagedFiles.includes(file), `${file} must be included in npm pack`);
}

console.log("admin page tests passed");
