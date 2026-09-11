"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createCredentialStore } = require("../lib/credential-store");
const { writePrivateFile, readFileSnapshot, atomicReplacePrivate, verifyPrivateRegularFile } = require("../lib/file-safety");
const { runSetup } = require("../lib/setup");
const { loadConfig } = require("../lib/config");
const { windowsLauncher } = require("../lib/service");
const { powershellPath, runWindows } = require("../lib/windows");

async function main() {
  if (process.platform !== "win32") { console.log("Windows native tests require Windows; skipped on this host."); return; }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-native-中文 O'Brien space-"));
  const store = createCredentialStore({ home });
  const secret = "synthetic-native-credential";
  let runner;
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "native", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
  });
  try {
    const privateFile = path.join(home, "private.json");
    writePrivateFile(privateFile, '{"before":true}');
    verifyPrivateRegularFile(privateFile);
    atomicReplacePrivate(readFileSnapshot(privateFile), '{"after":true}');
    verifyPrivateRegularFile(privateFile);
    assert.equal(JSON.parse(fs.readFileSync(privateFile, "utf8")).after, true);

    store.save("coding", Buffer.from(secret));
    assert.equal(store.read("coding"), secret);
    const descriptor = store.descriptor("coding");
    assert.doesNotMatch(JSON.stringify(descriptor), new RegExp(secret));
    const encryptedFile = descriptor.command.args.at(-1);
    assert.doesNotMatch(fs.readFileSync(encryptedFile, "utf8"), new RegExp(secret));
    verifyPrivateRegularFile(encryptedFile);
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const portProbe = http.createServer();
    await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const port = portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));
    const setup = await runSetup({
      provider: { name: "Native test", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` },
      models: [{ alias: "coding", upstreamModel: "synthetic-model", credential: { source: "stored" } }],
      clients: [], service: "none", probe: "none", server: { port },
    }, { home });
    const config = loadConfig(setup.configFile);
    const launcher = path.join(home, "start.ps1");
    const logs = path.join(home, "logs");
    writePrivateFile(launcher, windowsLauncher(process.execPath, config.path, logs));
    // Native COM validation checks the logon trigger, principal, retry settings and action.
    // No task is registered and CI needs no logged-in desktop session.
    runWindows("windows-service.ps1", ["-Action", "Validate", "-Name", `LCB validation ${process.pid}`, "-Launcher", launcher]);
    assert.equal(JSON.parse(runWindows("windows-service.ps1", ["-Action", "Status", "-Name", `LCB missing ${process.pid}`])).installed, false);
    runner = spawn(powershellPath(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher], { stdio: "ignore", windowsHide: true });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (runner.exitCode !== null) throw new Error("Windows launcher exited before the bridge became ready.");
      try { ready = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()).ok === true; } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready, "Windows launcher must start the bridge");
    const result = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.server.localToken}` },
      body: JSON.stringify({ model: "coding", messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).choices[0].message.content, "ok");
    assert.doesNotMatch(fs.readFileSync(path.join(logs, "err.log"), "utf8"), new RegExp(secret));
    store.delete("coding");
    assert.throws(() => store.read("coding"), /Windows operation failed/);
  } finally {
    if (runner?.pid && runner.exitCode === null) {
      const exited = new Promise((resolve) => runner.once("exit", resolve));
      spawnSync("taskkill.exe", ["/PID", String(runner.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 10000 });
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log("Windows native credential, ACL, task validation and background request tests passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
