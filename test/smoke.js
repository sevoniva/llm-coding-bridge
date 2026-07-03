"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

let bridgeProcess = null;
let upstreamServer = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function requestText(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return text;
}

function runCli(cli, args, options = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, ...(options.env || {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

function sse(res, body) {
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llm-coding-bridge-"));
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      upstreamRequests += 1;
      const payload = JSON.parse(raw);
      const prompt = payload.messages[payload.messages.length - 1].content;
      const text = prompt.includes("exactly") ? "OK" : `echo:${prompt}`;
      if (payload.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        sse(res, { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] });
        sse(res, { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "chatcmpl-test", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstream.unref();
  upstreamServer = upstream;

  const upstreamPort = upstream.address().port;
  const configPath = path.join(tmp, "bridge.config.json");
  const bridgePort = upstreamPort + 1;
  fs.writeFileSync(configPath, JSON.stringify({
    server: { host: "127.0.0.1", port: bridgePort },
    upstream: {
      name: "fake-upstream",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "fake-model",
      apiKeyEnv: "FAKE_API_KEY"
    }
  }, null, 2));

  const cli = path.join(__dirname, "..", "bin", "llm-coding-bridge.js");
  const bridge = spawn(process.execPath, [cli, "serve", "--config", configPath], {
    env: { ...process.env, FAKE_API_KEY: "upstream-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridgeProcess = bridge;
  let bridgeOut = "";
  let bridgeErr = "";
  bridge.stdout.on("data", (chunk) => { bridgeOut += chunk; });
  bridge.stderr.on("data", (chunk) => { bridgeErr += chunk; });

  for (let i = 0; i < 50; i += 1) {
    try {
      const health = await fetch(`http://127.0.0.1:${bridgePort}/health`);
      if (health.status === 200) break;
    } catch {}
    await wait(100);
  }

  const chat = await requestJson(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    model: "client-model",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  });
  assert.equal(chat.choices[0].message.content, "echo:hello");

  const stream = await requestText(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    model: "client-model",
    messages: [{ role: "user", content: "stream" }],
    stream: true,
  });
  assert.match(stream, /data:/);
  assert.match(stream, /echo:stream/);

  const responses = await requestJson(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    model: "client-model",
    input: "hello responses",
    stream: false,
  });
  assert.equal(responses.output_text, "echo:hello responses");
  assert.equal(responses.output[0].content[0].text, "echo:hello responses");

  const models = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`, { headers: { Authorization: "Bearer test" } });
  assert.equal(models.status, 200);
  const modelsBody = await models.json();
  assert.equal(modelsBody.data[0].id, "fake-model");
  assert.equal(modelsBody.models[0].slug, "fake-model");
  assert.equal(modelsBody.models[0].context_window, 128000);
  assert.ok(modelsBody.models[0].model_messages);

  const status = await runCli(cli, ["status", "--config", configPath]);
  assert.equal(status.code, 0, status.stderr || status.stdout);
  assert.match(status.stdout, /health/);
  assert.match(status.stdout, /models/);

  const claude = await requestJson(`http://127.0.0.1:${bridgePort}/v1/messages`, {
    model: "client-model",
    max_tokens: 64,
    messages: [{ role: "user", content: "hello claude" }],
    stream: false,
  }, { "anthropic-version": "2023-06-01", "x-api-key": "local" });
  assert.equal(claude.content[0].text, "echo:hello claude");

  const claudeStream = await requestText(`http://127.0.0.1:${bridgePort}/v1/messages`, {
    model: "client-model",
    max_tokens: 64,
    messages: [{ role: "user", content: "stream claude" }],
    stream: true,
  }, { "anthropic-version": "2023-06-01", "x-api-key": "local" });
  assert.match(claudeStream, /content_block_delta/);
  assert.match(claudeStream, /echo:stream claude/);

  const doctor = spawn(process.execPath, [cli, "doctor", "--config", configPath], {
    env: { ...process.env, FAKE_API_KEY: "upstream-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let doctorOut = "";
  let doctorErr = "";
  doctor.stdout.on("data", (chunk) => { doctorOut += chunk; });
  doctor.stderr.on("data", (chunk) => { doctorErr += chunk; });
  const doctorCode = await new Promise((resolve) => doctor.on("close", resolve));
  assert.equal(doctorCode, 0, doctorErr || doctorOut);
  assert.match(doctorOut, /OK/);

  const deepDoctor = await runCli(cli, ["doctor", "--deep", "--config", configPath], { env: { FAKE_API_KEY: "upstream-key" } });
  assert.equal(deepDoctor.code, 0, deepDoctor.stderr || deepDoctor.stdout);
  assert.match(deepDoctor.stdout, /responses/);
  assert.match(deepDoctor.stdout, /messages/);

  const profileHome = path.join(tmp, "profile-home");
  const profile = await runCli(cli, ["codex-profile", "--config", configPath, "--name", "bridge", "--home", profileHome]);
  assert.equal(profile.code, 0, profile.stderr || profile.stdout);
  const profilePath = path.join(profileHome, ".codex", "bridge.config.toml");
  const catalogPath = path.join(profileHome, ".llm-coding-bridge", "codex-model-catalog.json");
  assert.match(fs.readFileSync(profilePath, "utf8"), /model = "fake-model"/);
  assert.match(fs.readFileSync(profilePath, "utf8"), /model_catalog_json = /);
  assert.equal(JSON.parse(fs.readFileSync(catalogPath, "utf8")).models[0].slug, "fake-model");

  const repeatProfile = await runCli(cli, ["codex-profile", "--config", configPath, "--name", "bridge", "--home", profileHome]);
  assert.notEqual(repeatProfile.code, 0);
  const forceProfile = await runCli(cli, ["codex-profile", "--config", configPath, "--name", "bridge", "--home", profileHome, "--force"]);
  assert.equal(forceProfile.code, 0, forceProfile.stderr || forceProfile.stdout);

  const logHome = path.join(tmp, "log-home");
  const logDir = path.join(logHome, ".llm-coding-bridge", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "out.log"), "old out\nnew out\n");
  fs.writeFileSync(path.join(logDir, "err.log"), "old err\nnew err\n");
  const logs = await runCli(cli, ["logs", "--home", logHome, "--lines", "1"]);
  assert.equal(logs.code, 0, logs.stderr || logs.stdout);
  assert.match(logs.stdout, /new out/);
  assert.match(logs.stdout, /new err/);

  const initPath = path.join(tmp, "init.json");
  const init = spawn(process.execPath, [cli, "init", "--out", initPath, "--no-doctor"], { stdio: ["pipe", "pipe", "pipe"] });
  init.stdin.end([
    "127.0.0.1",
    "18080",
    "Example Provider",
    "https://api.example.com/v1",
    "example-model",
    "EXAMPLE_API_KEY",
    "",
    "0"
  ].join("\n"));
  let initErr = "";
  init.stderr.on("data", (chunk) => { initErr += chunk; });
  const initCode = await new Promise((resolve) => init.on("close", resolve));
  assert.equal(initCode, 0, initErr);
  const initConfig = JSON.parse(fs.readFileSync(initPath, "utf8"));
  assert.equal(initConfig.server.port, 18080);
  assert.equal(initConfig.upstream.name, "Example Provider");
  assert.equal(initConfig.upstream.apiKeyEnv, "EXAMPLE_API_KEY");

  for (const templateName of ["codex", "codex-desktop", "claude"]) {
    const template = spawn(process.execPath, [cli, "template", templateName], { stdio: ["ignore", "pipe", "pipe"] });
    let templateOut = "";
    let templateErr = "";
    template.stdout.on("data", (chunk) => { templateOut += chunk; });
    template.stderr.on("data", (chunk) => { templateErr += chunk; });
    const templateCode = await new Promise((resolve) => template.on("close", resolve));
    assert.equal(templateCode, 0, templateErr || templateOut);
    assert.ok(templateOut.length > 0);
  }

  assert.ok(upstreamRequests >= 4);
  bridge.kill("SIGTERM");
  await new Promise((resolve) => bridge.on("close", resolve));
  await new Promise((resolve) => upstream.close(resolve));
  bridgeProcess = null;
  upstreamServer = null;
}

main().catch((error) => {
  if (bridgeProcess && !bridgeProcess.killed) bridgeProcess.kill("SIGTERM");
  if (upstreamServer) upstreamServer.close();
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
