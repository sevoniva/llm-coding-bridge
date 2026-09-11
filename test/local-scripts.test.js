"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { loadConfig, getApiKey } = require("../lib/config");
const { startServer } = require("../lib/server");
const { effectiveConfigDocument, migrationPlan, applyMigrationPlan } = require("../lib/config-output");
const { readFileSnapshot } = require("../lib/file-safety");
const { initLocalFiles, scriptText, waitForConfig, reloadLocalConfig } = require("../lib/local-scripts");

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-click-中文 space '-"));
  const root = path.join(home, "my bridge");
  const secret = "synthetic-inline-secret";
  const seenKeys = [];
  const upstream = http.createServer((req, res) => {
    seenKeys.push(req.headers.authorization);
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "simple", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
  });
  let bridge;
  try {
    const files = initLocalFiles(root, { home });
    const placeholder = fs.readFileSync(files.configFile, "utf8");
    let invoked = false;
    await assert.rejects(() => reloadLocalConfig(files.configFile, { restartService() { invoked = true; } }), /Edit config.json/);
    assert.equal(invoked, false, "unfilled templates must not install a service");
    for (const platform of ["win32", "darwin"]) {
      const restart = scriptText("reload", { platform, home, node: "C:\\Program Files\\Node%20\\node.exe" });
      assert.match(restart, /reload/);
      assert.match(restart, platform === "win32" ? /%~dp0config\.json/ : /\$SCRIPT_DIR\/config\.json/);
      if (platform === "win32") {
        assert.match(restart, /DisableDelayedExpansion/);
        assert.match(restart, /Node%%20/);
      }
    }
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const portProbe = http.createServer();
    await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const port = portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));
    const document = JSON.parse(placeholder);
    document.server.port = port;
    document.upstream = { name: "Simple", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: "coding", apiKey: secret };
    fs.writeFileSync(files.configFile, `\uFEFF${JSON.stringify(document)}`);
    initLocalFiles(root, { home });
    assert.equal(loadConfig(files.configFile).defaultUpstream.apiKey, secret, "script regeneration preserves the edited file");
    const config = loadConfig(files.configFile);
    assert.equal(getApiKey(config.defaultUpstream), secret);
    assert.doesNotMatch(JSON.stringify(effectiveConfigDocument(config)), new RegExp(secret));
    await reloadLocalConfig(files.configFile, { home, restartService(file) {
      assert.equal(file, files.configFile);
      bridge = startServer(loadConfig(file));
    } });
    const base = `http://127.0.0.1:${port}`;
    const request = () => fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "coding", messages: [{ role: "user", content: "test" }] }),
    });
    assert.equal((await (await request()).json()).choices[0].message.content, "ok");
    assert.deepEqual(seenKeys, [`Bearer ${secret}`]);
    const admin = await (await fetch(`${base}/admin/api/status`)).json();
    assert.equal(admin.routes[0].credentialAvailable, true);
    assert.doesNotMatch(JSON.stringify(admin), new RegExp(secret));

    document.upstream.apiKey = "synthetic-replaced-secret";
    document.upstream.model = "coding-new";
    fs.writeFileSync(files.configFile, JSON.stringify(document));
    const updated = loadConfig(files.configFile);
    assert.notEqual(updated.revision, config.revision);
    await assert.rejects(() => waitForConfig(updated, { timeoutMs: 20, intervalMs: 5 }), /did not load this config/);
    bridge.closeAllConnections();
    await new Promise((resolve) => bridge.close(resolve));
    await reloadLocalConfig(files.configFile, { home, restartService(file) { bridge = startServer(loadConfig(file)); } });
    assert.equal((await (await request()).json()).choices[0].message.content, "ok");
    assert.deepEqual(seenKeys, [`Bearer ${secret}`, "Bearer synthetic-replaced-secret"]);

    const plan = migrationPlan(updated, readFileSnapshot(files.configFile));
    assert.doesNotMatch(JSON.stringify(plan.preview), /synthetic-replaced-secret/);
    applyMigrationPlan(plan);
    const migrated = loadConfig(files.configFile);
    assert.equal(migrated.version, 2);
    assert.equal(migrated.credentialResolver.resolve(migrated.routes[0].credentialRef), "synthetic-replaced-secret");
    assert.doesNotMatch(JSON.stringify(effectiveConfigDocument(migrated)), /synthetic-replaced-secret/);
  } finally {
    if (bridge) { bridge.closeAllConnections(); await new Promise((resolve) => bridge.close(resolve)); }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log("single-file configuration, reload, scripts and secret redaction tests passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
