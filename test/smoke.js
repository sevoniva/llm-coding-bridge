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

async function requestRaw(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
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

// Spawn a bridge on a random port (port:0) and resolve once it's listening.
// Avoids fixed-port collisions that made the suite flaky across runs.
function spawnBridge(cli, configPath, env = {}) {
  const child = spawn(process.execPath, [cli, "serve", "--config", configPath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const m = stderr.match(/listening on http:\/\/[\d.]+:(\d+)\/v1/);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on("close", () => reject(new Error(`bridge exited before listening: ${stderr}`)));
    setTimeout(() => reject(new Error("bridge listen timeout")), 10000);
  });
}

// Reserve a free port by binding to :0 then closing, so it can be written into
// a config file for commands (status/doctor) that read the port from config.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

function sse(res, body) {
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "llm-coding-bridge-"));
  let upstreamRequests = 0;
  let upstreamStreamClosed = false;
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
      if (prompt.includes("upstream fail")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "authorization=secret-token" }));
        return;
      }
      const tool = (payload.tools || []).map((item) => item.function).find((item) => item?.name === "bridge_probe" || item?.name === "bridge_freeform" || item?.name === "tool_search");
      if (tool) {
        const args = tool.name === "tool_search" ? { query: "Gmail search emails" } : { input: "OK" };
        const message = { role: "assistant", content: null, tool_calls: [{ id: "call_probe", type: "function", function: { name: tool.name, arguments: JSON.stringify(args) } }] };
        if (payload.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          sse(res, { id: "chatcmpl-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: tool.name } }] } }] });
          if (tool.name === "tool_search") {
            sse(res, { id: "chatcmpl-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] });
          } else {
            sse(res, { id: "chatcmpl-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{\"input\":" } }] } }] });
            sse(res, { id: "chatcmpl-tool", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"OK\"}" } }] }, finish_reason: "tool_calls" }] });
          }
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "chatcmpl-tool", object: "chat.completion", choices: [{ index: 0, message, finish_reason: "tool_calls" }] }));
        return;
      }
      const text = prompt.includes("exactly") ? "OK" : `echo:${prompt}`;
      if (prompt.includes("long stream")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        sse(res, { id: "chatcmpl-long", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "partial" } }] });
        res.on("close", () => { upstreamStreamClosed = true; });
        return;
      }
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
  const bridgePort = await freePort();
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
  const { child: bridge } = await spawnBridge(cli, configPath, { FAKE_API_KEY: "upstream-key" });
  bridgeProcess = bridge;

  const chat = await requestJson(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    model: "client-model",
    messages: [{ role: "user", content: "hello" }],
    stream: false,
  });
  assert.equal(chat.choices[0].message.content, "echo:hello");

  const upstreamError = await requestRaw(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    model: "client-model",
    messages: [{ role: "user", content: "upstream fail" }],
    stream: false,
  });
  assert.equal(upstreamError.status, 401);
  assert.match(upstreamError.text, /Upstream HTTP 401/);
  assert.doesNotMatch(upstreamError.text, /secret-token/);

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

  const compact = await requestJson(`http://127.0.0.1:${bridgePort}/v1/responses/compact`, {
    model: "client-model",
    input: "hello compact",
    stream: false,
  });
  assert.equal(compact.output_text, "echo:hello compact");

  const responsesWithTools = await requestJson(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    model: "client-model",
    input: "use tool",
    stream: false,
    tools: [{ type: "function", function: { name: "test_tool", description: "A test tool", parameters: { type: "object", properties: {} } } }],
  });
  assert.equal(responsesWithTools.output_text, "echo:use tool");

  const customTool = await requestJson(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    model: "client-model",
    input: "use custom tool",
    stream: false,
    tools: [{ type: "custom", name: "bridge_freeform", description: "Freeform tool" }],
  });
  assert.equal(customTool.output[0].type, "custom_tool_call");
  assert.equal(customTool.output[0].name, "bridge_freeform");
  assert.equal(customTool.output[0].input, "OK");

  const customStream = await requestText(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    model: "client-model",
    input: "stream custom tool",
    stream: true,
    tools: [{ type: "custom", name: "bridge_freeform", description: "Freeform tool" }],
  });
  assert.match(customStream, /response.custom_tool_call_input.delta/);
  assert.match(customStream, /"delta":"OK"/);
  assert.doesNotMatch(customStream, /"delta":"\\{\\"input\\"/);

  const searchTool = await requestJson(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    model: "client-model",
    input: "search tools",
    stream: false,
    tools: [{ type: "tool_search" }],
  });
  assert.equal(searchTool.output[0].type, "tool_search_call");
  assert.equal(searchTool.output[0].execution, "client");
  assert.equal(searchTool.output[0].arguments.query, "Gmail search emails");

  // 流式异常：上游 !ok 时收到 response.failed 而非 response.completed
  const failStream = await requestRaw(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    model: "fake-model",
    input: "upstream fail",
    stream: true,
  });
  assert.match(failStream.text, /response\.failed/);
  assert.doesNotMatch(failStream.text, /response\.completed/);

  const models = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`, { headers: { Authorization: "Bearer test" } });
  assert.equal(models.status, 200);
  const modelsBody = await models.json();
  assert.equal(modelsBody.data[0].id, "fake-model");
  assert.equal(modelsBody.models[0].slug, "fake-model");
  assert.equal(modelsBody.models[0].context_window, 128000);
  assert.deepEqual(modelsBody.models[0].input_modalities, ["text"]);
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
  const toolsDoctor = await runCli(cli, ["doctor", "--tools", "--config", configPath], { env: { FAKE_API_KEY: "upstream-key" } });
  assert.equal(toolsDoctor.code, 0, toolsDoctor.stderr || toolsDoctor.stdout);
  assert.match(toolsDoctor.stdout, /function tool call/);
  assert.match(toolsDoctor.stdout, /custom tool call/);
  assert.match(toolsDoctor.stdout, /tool-search call/);

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
    "0",
    ""
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

  // 客户端断开取消上游 reader
  const abortRes = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "long stream" }], stream: true }),
  });
  await wait(100);
  abortRes.body.cancel();
  await wait(400);
  assert.equal(upstreamStreamClosed, true, "upstream stream should be closed when client disconnects");

  // apiKeyCommand 缓存：多次请求只 spawn 一次
  const cmdTmp = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-cmd-"));
  const counterFile = path.join(cmdTmp, "count");
  const cmdScript = path.join(cmdTmp, "key.sh");
  fs.writeFileSync(cmdScript, `#!/bin/sh\necho x >> "${counterFile}"\necho "cmd-key"\n`);
  fs.chmodSync(cmdScript, 0o755);
  const cmdConfigPath = path.join(cmdTmp, "bridge.config.json");
  fs.writeFileSync(cmdConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    upstream: {
      name: "fake-upstream",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "fake-model",
      apiKeyCommand: { command: cmdScript, args: [] },
    },
  }, null, 2));
  const { child: cmdBridge, port: cmdBridgePort } = await spawnBridge(cli, cmdConfigPath);
  for (let i = 0; i < 3; i += 1) {
    await requestJson(`http://127.0.0.1:${cmdBridgePort}/v1/chat/completions`, {
      model: "fake-model",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
  }
  const count = fs.readFileSync(counterFile, "utf8").trim().split("\n").length;
  assert.equal(count, 1, `apiKeyCommand should spawn once, got ${count}`);
  cmdBridge.kill("SIGTERM");
  await new Promise((resolve) => cmdBridge.on("close", resolve));

  // apiKeyCacheTtlMs:0 禁用缓存，每次请求都 spawn
  const nocacheCounter = path.join(cmdTmp, "count0");
  const nocacheScript = path.join(cmdTmp, "key0.sh");
  fs.writeFileSync(nocacheScript, `#!/bin/sh\necho x >> "${nocacheCounter}"\necho "cmd-key"\n`);
  fs.chmodSync(nocacheScript, 0o755);
  const nocacheConfigPath = path.join(cmdTmp, "nocache.config.json");
  fs.writeFileSync(nocacheConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    upstream: {
      name: "fake-upstream",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "fake-model",
      apiKeyCommand: { command: nocacheScript, args: [] },
      apiKeyCacheTtlMs: 0,
    },
  }, null, 2));
  const { child: nocacheBridge, port: nocacheBridgePort } = await spawnBridge(cli, nocacheConfigPath);
  for (let i = 0; i < 3; i += 1) {
    await requestJson(`http://127.0.0.1:${nocacheBridgePort}/v1/chat/completions`, {
      model: "fake-model", messages: [{ role: "user", content: "hello" }], stream: false,
    });
  }
  const nocacheCount = fs.readFileSync(nocacheCounter, "utf8").trim().split("\n").length;
  assert.equal(nocacheCount, 3, `apiKeyCacheTtlMs:0 should spawn per request, got ${nocacheCount}`);
  nocacheBridge.kill("SIGTERM");
  await new Promise((resolve) => nocacheBridge.on("close", resolve));

  // apiKey 缓存 401 失效：第一次 key 错 401 → bust → 第二次 key 对 200
  const rotateTmp = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-rot-"));
  const rotateCounter = path.join(rotateTmp, "n");
  const rotateScript = path.join(rotateTmp, "key.sh");
  // 第一次返回 wrong-key，第二次起返回 right-key
  fs.writeFileSync(rotateScript, `#!/bin/sh\nn=$(cat "${rotateCounter}" 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > "${rotateCounter}"\nif [ "$n" = "1" ]; then echo "wrong-key"; else echo "right-key"; fi\n`);
  fs.chmodSync(rotateScript, 0o755);
  const rotateUpstream = http.createServer((req, res) => {
    let raw = ""; req.setEncoding("utf8"); req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const auth = req.headers.authorization || "";
      if (auth !== "Bearer right-key") { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "bad key" })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "r", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise((resolve) => rotateUpstream.listen(0, "127.0.0.1", resolve));
  rotateUpstream.unref();
  const rotatePort = rotateUpstream.address().port;
  const rotateConfigPath = path.join(rotateTmp, "rotate.config.json");
  fs.writeFileSync(rotateConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    upstream: { name: "u", baseUrl: `http://127.0.0.1:${rotatePort}/v1`, model: "m", apiKeyCommand: { command: rotateScript, args: [] } },
  }, null, 2));
  const { child: rotateBridge, port: rotateBridgePort } = await spawnBridge(cli, rotateConfigPath);
  const rotateFirst = await requestRaw(`http://127.0.0.1:${rotateBridgePort}/v1/chat/completions`, {
    model: "m", messages: [{ role: "user", content: "hello" }], stream: false,
  });
  assert.equal(rotateFirst.status, 401);
  const rotateSecond = await requestJson(`http://127.0.0.1:${rotateBridgePort}/v1/chat/completions`, {
    model: "m", messages: [{ role: "user", content: "hello" }], stream: false,
  });
  assert.equal(rotateSecond.choices[0].message.content, "OK");
  rotateBridge.kill("SIGTERM");
  await new Promise((resolve) => rotateBridge.on("close", resolve));
  await new Promise((resolve) => rotateUpstream.close(resolve));

  // 可选本地 token 鉴权
  const authConfigPath = path.join(tmp, "auth.config.json");
  fs.writeFileSync(authConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0, localToken: "secret-token-xyz" },
    upstream: { name: "fake-upstream", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: "fake-model", apiKeyEnv: "FAKE_API_KEY" },
  }, null, 2));
  const { child: authBridge, port: authBridgePort } = await spawnBridge(cli, authConfigPath, { FAKE_API_KEY: "upstream-key" });
  const healthNoAuth = await fetch(`http://127.0.0.1:${authBridgePort}/health`);
  assert.equal(healthNoAuth.status, 200);
  const noToken = await requestRaw(`http://127.0.0.1:${authBridgePort}/v1/chat/completions`, {
    model: "fake-model", messages: [{ role: "user", content: "hello" }], stream: false,
  });
  assert.equal(noToken.status, 401);
  const wrongToken = await requestRaw(`http://127.0.0.1:${authBridgePort}/v1/chat/completions`, {
    model: "fake-model", messages: [{ role: "user", content: "hello" }], stream: false,
  }, { Authorization: "Bearer wrong" });
  assert.equal(wrongToken.status, 401);
  const okBearer = await requestJson(`http://127.0.0.1:${authBridgePort}/v1/chat/completions`, {
    model: "fake-model", messages: [{ role: "user", content: "hello" }], stream: false,
  }, { Authorization: "Bearer secret-token-xyz" });
  assert.equal(okBearer.choices[0].message.content, "echo:hello");
  const okApiKey = await requestJson(`http://127.0.0.1:${authBridgePort}/v1/chat/completions`, {
    model: "fake-model", messages: [{ role: "user", content: "hello" }], stream: false,
  }, { "x-api-key": "secret-token-xyz" });
  assert.equal(okApiKey.choices[0].message.content, "echo:hello");
  authBridge.kill("SIGTERM");
  await new Promise((resolve) => authBridge.on("close", resolve));

  // doctor 能带上 localToken 鉴权
  const docAuthConfigPath = path.join(tmp, "docauth.config.json");
  const docAuthBridgePort = await freePort();
  fs.writeFileSync(docAuthConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: docAuthBridgePort, localToken: "secret-token-xyz" },
    upstream: { name: "fake-upstream", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: "fake-model", apiKeyEnv: "FAKE_API_KEY" },
  }, null, 2));
  const { child: docAuthBridge } = await spawnBridge(cli, docAuthConfigPath, { FAKE_API_KEY: "upstream-key" });
  void docAuthBridgePort;
  const docAuthStatus = await runCli(cli, ["status", "--config", docAuthConfigPath]);
  assert.equal(docAuthStatus.code, 0, docAuthStatus.stderr || docAuthStatus.stdout);
  assert.match(docAuthStatus.stdout, /health/);
  docAuthBridge.kill("SIGTERM");
  await new Promise((resolve) => docAuthBridge.on("close", resolve));

  // 多上游 model 路由
  const upstream2 = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    let raw = ""; req.setEncoding("utf8"); req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "u2", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "from-upstream-2" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise((resolve) => upstream2.listen(0, "127.0.0.1", resolve));
  upstream2.unref();
  const upstream2Port = upstream2.address().port;
  const multiConfigPath = path.join(tmp, "multi.config.json");
  fs.writeFileSync(multiConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    upstreams: [
      { name: "u1", model: "model-a", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKeyEnv: "FAKE_API_KEY" },
      { name: "u2", model: "model-b", baseUrl: `http://127.0.0.1:${upstream2Port}/v1`, apiKeyEnv: "FAKE_API_KEY" },
    ],
  }, null, 2));
  const { child: multiBridge, port: multiBridgePort } = await spawnBridge(cli, multiConfigPath, { FAKE_API_KEY: "upstream-key" });
  const routeA = await requestJson(`http://127.0.0.1:${multiBridgePort}/v1/chat/completions`, {
    model: "model-a", messages: [{ role: "user", content: "hello" }], stream: false,
  });
  assert.equal(routeA.choices[0].message.content, "echo:hello");
  const routeB = await requestJson(`http://127.0.0.1:${multiBridgePort}/v1/chat/completions`, {
    model: "model-b", messages: [{ role: "user", content: "hello" }], stream: false,
  });
  assert.equal(routeB.choices[0].message.content, "from-upstream-2");
  const multiModels = await fetch(`http://127.0.0.1:${multiBridgePort}/v1/models`, { headers: { Authorization: "Bearer test" } });
  const multiModelsBody = await multiModels.json();
  assert.equal(multiModelsBody.data.length, 2);
  // 多上游时未知 model 报 404，不静默回退
  const unknownModel = await requestRaw(`http://127.0.0.1:${multiBridgePort}/v1/chat/completions`, {
    model: "nonexistent-model", messages: [{ role: "user", content: "hello" }], stream: false,
  });
  assert.equal(unknownModel.status, 404);
  multiBridge.kill("SIGTERM");
  await new Promise((resolve) => multiBridge.on("close", resolve));
  await new Promise((resolve) => upstream2.close(resolve));

  // 优雅退出：SIGTERM 终止进行中流式响应
  const graceConfigPath = path.join(tmp, "grace.config.json");
  fs.writeFileSync(graceConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    upstream: { name: "fake-upstream", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: "fake-model", apiKeyEnv: "FAKE_API_KEY" },
  }, null, 2));
  const { child: graceBridge, port: graceBridgePort } = await spawnBridge(cli, graceConfigPath, { FAKE_API_KEY: "upstream-key" });
  const graceStreamRes = await fetch(`http://127.0.0.1:${graceBridgePort}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ model: "fake-model", input: "long stream", stream: true }),
  });
  const graceReader = graceStreamRes.body.getReader();
  const graceFirst = await graceReader.read();
  graceBridge.kill("SIGTERM");
  const graceChunks = [];
  try {
    while (true) {
      const { done, value } = await graceReader.read();
      if (done) break;
      graceChunks.push(Buffer.from(value).toString("utf8"));
    }
  } catch {}
  const graceFull = (graceFirst.value ? Buffer.from(graceFirst.value).toString("utf8") : "") + graceChunks.join("");
  assert.match(graceFull, /response\.failed|\[DONE\]/);

  // 优雅退出：Anthropic 流不被注入 [DONE]（[DONE] 是 OpenAI 约定，会破坏 Anthropic 客户端）
  const grace2ConfigPath = path.join(tmp, "grace2.config.json");
  fs.writeFileSync(grace2ConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    upstream: { name: "fake-upstream", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: "fake-model", apiKeyEnv: "FAKE_API_KEY" },
  }, null, 2));
  const { child: grace2Bridge, port: grace2BridgePort } = await spawnBridge(cli, grace2ConfigPath, { FAKE_API_KEY: "upstream-key" });
  const grace2Res = await fetch(`http://127.0.0.1:${grace2BridgePort}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "fake-model", max_tokens: 64, messages: [{ role: "user", content: "stream claude" }], stream: true }),
  });
  const grace2Reader = grace2Res.body.getReader();
  const grace2First = await grace2Reader.read();
  grace2Bridge.kill("SIGTERM");
  const grace2Chunks = [];
  try {
    while (true) {
      const { done, value } = await grace2Reader.read();
      if (done) break;
      grace2Chunks.push(Buffer.from(value).toString("utf8"));
    }
  } catch {}
  const grace2Full = (grace2First.value ? Buffer.from(grace2First.value).toString("utf8") : "") + grace2Chunks.join("");
  assert.doesNotMatch(grace2Full, /\[DONE\]/);

  // 优雅退出：chat 流式收到 [DONE]（OpenAI 约定）
  const grace3ConfigPath = path.join(tmp, "grace3.config.json");
  fs.writeFileSync(grace3ConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: 0 },
    upstream: { name: "fake-upstream", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: "fake-model", apiKeyEnv: "FAKE_API_KEY" },
  }, null, 2));
  const { child: grace3Bridge, port: grace3BridgePort } = await spawnBridge(cli, grace3ConfigPath, { FAKE_API_KEY: "upstream-key" });
  const grace3Res = await fetch(`http://127.0.0.1:${grace3BridgePort}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "long stream" }], stream: true }),
  });
  const grace3Reader = grace3Res.body.getReader();
  const grace3First = await grace3Reader.read();
  grace3Bridge.kill("SIGTERM");
  const grace3Chunks = [];
  try {
    while (true) {
      const { done, value } = await grace3Reader.read();
      if (done) break;
      grace3Chunks.push(Buffer.from(value).toString("utf8"));
    }
  } catch {}
  const grace3Full = (grace3First.value ? Buffer.from(grace3First.value).toString("utf8") : "") + grace3Chunks.join("");
  assert.match(grace3Full, /\[DONE\]/);

  // 请求体大小限制
  const bigBody = JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "x".repeat(11 * 1024 * 1024) }], stream: false });
  const bigRes = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: bigBody,
  });
  assert.equal(bigRes.status, 413);

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
