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

  // apiKeyCommand 缓存：多次请求只 spawn 一次
  const cmdTmp = fs.mkdtempSync(path.join(os.tmpdir(), "lcb-cmd-"));
  const counterFile = path.join(cmdTmp, "count");
  const cmdScript = path.join(cmdTmp, "key.sh");
  fs.writeFileSync(cmdScript, `#!/bin/sh\necho x >> "${counterFile}"\necho "cmd-key"\n`);
  fs.chmodSync(cmdScript, 0o755);
  const cmdConfigPath = path.join(cmdTmp, "bridge.config.json");
  const cmdBridgePort = upstreamPort + 2;
  fs.writeFileSync(cmdConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: cmdBridgePort },
    upstream: {
      name: "fake-upstream",
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      model: "fake-model",
      apiKeyCommand: { command: cmdScript, args: [] },
    },
  }, null, 2));
  const cmdBridge = spawn(process.execPath, [cli, "serve", "--config", cmdConfigPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i += 1) {
    try {
      const h = await fetch(`http://127.0.0.1:${cmdBridgePort}/health`);
      if (h.status === 200) break;
    } catch {}
    await wait(100);
  }
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
