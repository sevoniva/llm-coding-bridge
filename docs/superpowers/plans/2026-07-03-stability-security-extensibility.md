# llm-coding-bridge 稳定性/安全/可扩展改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 llm-coding-bridge 改造到生产级：修复流式静默截断与 apiKey 高频 spawn、加可选鉴权与断开取消、拆分单文件并支持多上游 model 路由与优雅退出、加请求体限制，最终发布 0.2.0。

**Architecture:** 分 4 批渐进。批次1/2 在现有单文件 `bin/llm-coding-bridge.js` 上改（不依赖拆分）。批次3 先拆分到 `lib/`（纯重构），再加多上游路由与优雅退出。批次4 加请求体限制。每批结束 smoke 测试 + lint + security:scan 全绿后提交。

**Tech Stack:** Node.js >=18，零运行时依赖，`node:http` + `fetch`，`node:assert` 端到端 smoke 测试，macOS launchd 服务。

**Spec:** `docs/superpowers/specs/2026-07-03-stability-security-extensibility-design.md`

---

## 文件结构

批次1/2 仅修改 `bin/llm-coding-bridge.js` 与 `test/smoke.js`。批次3 拆分为：

```
bin/llm-coding-bridge.js      # CLI 入口 + parseArgs + main（薄）
lib/config.js                 # loadConfig, getApiKey（含缓存）, resolveUpstream, 配置校验
lib/server.js                 # startServer, 路由分发, 鉴权, 请求体限制, 优雅退出
lib/upstream.js               # fetchUpstream, fetchUpstreamJson, pipeStream
lib/converters/
  shared.js                   # textFromContent, toolArgumentsString 等共享工具
  responses.js                # responsesInputToMessages, ResponsesWriter, handleResponses
  anthropic.js                # anthropicToChatPayload, chatToAnthropic, streamAnthropic, handleAnthropicMessages
  chat.js                     # handleChat（透传）
lib/service.js                # installService, restartService, uninstallService, plist
lib/doctor.js                 # doctor, deepDoctor, toolsDoctor, status
lib/codex-profile.js          # createCodexProfile, codexCatalogModel, loadCodexModelTemplate
```

`package.json` 的 `files` 加入 `lib`。

---

## 批次1：P0 稳定性

### Task 1.1: apiKeyCommand 缓存

**Files:**
- Modify: `bin/llm-coding-bridge.js:66-85`（`getApiKey`）
- Test: `test/smoke.js`

- [ ] **Step 1: 写失败测试 — apiKeyCommand 只 spawn 一次**

在 `test/smoke.js` 的 `main()` 内，现有 `apiKeyEnv` 配置之后，新增一个用 `apiKeyCommand` 的 bridge 实例，发多次请求，断言 command 脚本只被执行一次。

在 `main()` 中 `bridge.kill` 之前插入：

```js
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
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node test/smoke.js`
Expected: FAIL — `count` 为 3（每次请求都 spawn），断言 `1 === 3` 失败。

- [ ] **Step 3: 实现 apiKey 缓存**

替换 `bin/llm-coding-bridge.js` 的 `getApiKey` 函数（第 66-85 行）为：

```js
const apiKeyCache = new Map();
const DEFAULT_API_KEY_TTL_MS = 10 * 60 * 1000;

function resolveApiKey(upstream) {
  if (upstream.apiKeyEnv && process.env[upstream.apiKeyEnv]) {
    return process.env[upstream.apiKeyEnv];
  }
  if (!upstream.apiKeyCommand) {
    throw new Error(`Missing API key env: ${upstream.apiKeyEnv}`);
  }
  const command = upstream.apiKeyCommand;
  const result =
    typeof command === "string"
      ? spawnSync("/bin/sh", ["-lc", command], { encoding: "utf8" })
      : spawnSync(command.command, command.args || [], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`apiKeyCommand exited with ${result.status}.`);
  const token = result.stdout.trim();
  if (!token) throw new Error("apiKeyCommand returned an empty token.");
  return token;
}

function getApiKey(upstream) {
  const ttl = Number(upstream.apiKeyCacheTtlMs || DEFAULT_API_KEY_TTL_MS);
  const cached = apiKeyCache.get(upstream);
  if (cached && Date.now() - cached.ts < ttl) return cached.value;
  const value = resolveApiKey(upstream);
  apiKeyCache.set(upstream, { value, ts: Date.now() });
  return value;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node test/smoke.js`
Expected: PASS（count === 1）

- [ ] **Step 5: 提交**

```bash
git add bin/llm-coding-bridge.js test/smoke.js
git commit -m "Cache apiKeyCommand result with TTL to avoid per-request spawn"
```

### Task 1.2: 流式异常发 failed 而非 completed

**Files:**
- Modify: `bin/llm-coding-bridge.js`（`ResponsesWriter` 类 ~488-699，`handleResponses` ~758-808，`handleAnthropicMessages` ~810-815）
- Test: `test/smoke.js`

- [ ] **Step 1: 写失败测试 — 上游 !ok 时 responses 收到 failed**

在 `test/smoke.js` 的 `main()` 中插入（在现有 responses 测试附近）：

```js
  // 流式异常：上游 !ok 时收到 response.failed 而非 response.completed
  const failStream = await requestText(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    model: "fake-model",
    input: "upstream fail",
    stream: true,
  });
  assert.match(failStream, /response\.failed/);
  assert.doesNotMatch(failStream, /response\.completed/);
```

注：`requestText` 用 `Authorization: Bearer test`，上游对含 "upstream fail" 的请求返回 401（现有 mock 已实现，见 smoke.js:81-85）。

- [ ] **Step 2: 运行测试验证失败**

Run: `node test/smoke.js`
Expected: FAIL — 当前 `handleResponses` 上游 `!ok` 时 `sendJson` 返回错误（非流式路径），但流式路径 `writer.start()` 已发 `response.created`，然后 `sendJson` 写一个 JSON 错误体到 SSE 流里，不含 `response.failed`。

- [ ] **Step 3: 给 ResponsesWriter 加 fail 方法**

在 `ResponsesWriter` 类的 `complete` 方法之后（约第 698 行）加入：

```js
  fail(message = "Upstream error.", code = "upstream_error") {
    this.finishMessage();
    this.finishTools();
    const response = this.response("failed");
    response.error = { message, code };
    if (this.res) {
      this.event("response.failed", { response });
      this.res.write("data: [DONE]\n\n");
      this.res.end();
    }
    return response;
  }
```

- [ ] **Step 4: handleResponses 上游 !ok 与异常走 fail**

替换 `handleResponses` 函数（约第 758-808 行）为：

```js
async function handleResponses(config, payload, res) {
  const chatPayload = responsesToChatPayload(config, payload);
  debug(
    `chat payload messages=${chatPayload.messages.map((m) => `${m.role}:${String(m.content || "").length}`).join(",")} tools=${chatPayload.tools?.length || 0}`,
  );
  const upstream = await fetchUpstream(config, chatPayload);
  const writer = new ResponsesWriter(config.upstream.model, payload.stream ? res : null, customToolNames(payload.tools), toolSearchNames(payload.tools));
  writer.start();
  if (!upstream.ok) {
    await upstream.text();
    writer.fail("Upstream error.", "upstream_error");
    if (!payload.stream) sendJson(res, 200, writer.fail("Upstream error.", "upstream_error"));
    return;
  }
  let usage = null;
  const contentType = upstream.headers.get("content-type") || "";
  try {
    if (contentType.includes("text/event-stream")) {
      await eachSseData(upstream.body, (data) => {
        if (data === "[DONE]") return;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        usage = chunk.usage || usage;
        for (const choice of chunk.choices || []) {
          const delta = choice.delta || {};
          if (delta.content) writer.textDelta(delta.content);
          for (const call of delta.tool_calls || []) {
            const fn = call.function || {};
            writer.toolDelta(call.index || 0, call.id, fn.name, fn.arguments || "");
          }
        }
      });
    } else {
      const data = await upstream.json();
      usage = data.usage || usage;
      const message = data.choices?.[0]?.message || {};
      if (message.content) writer.textDelta(message.content);
      for (const [index, call] of (message.tool_calls || []).entries()) {
        const fn = call.function || {};
        writer.toolDelta(index, call.id, fn.name, fn.arguments || "");
      }
    }
  } catch {
    writer.fail("Upstream error.", "upstream_error");
    if (!payload.stream) sendJson(res, 200, writer.response("failed"));
    return;
  }
  const response = writer.complete(usage);
  debug(`responses converted output=${response.output.length} text=${response.output_text.length}`);
  if (!payload.stream) sendJson(res, 200, response);
}
```

注意：`fail()` 在流式时已 `res.end()`，非流式时返回 response 对象但不 end。上面非流式 `!ok` 分支调用 `writer.fail()` 后再 `sendJson`——但 `fail()` 流式才 end，非流式安全。为避免非流式重复调用，简化为：

```js
  if (!upstream.ok) {
    await upstream.text();
    const failed = writer.fail("Upstream error.", "upstream_error");
    if (!payload.stream) sendJson(res, 200, failed);
    return;
  }
```

（`writer.fail` 在 `this.res` 为 null 时不写流，只返回 response 对象。）

- [ ] **Step 5: handleAnthropicMessages 上游 !ok 返回 Anthropic 错误体**

替换 `handleAnthropicMessages` 函数（约第 810-815 行）为：

```js
async function handleAnthropicMessages(config, payload, res) {
  const upstream = await fetchUpstream(config, { ...anthropicToChatPayload(config, payload), stream: false });
  const text = await upstream.text();
  if (!upstream.ok) {
    sendJson(res, upstream.status, { type: "error", error: { type: "api_error", message: "Upstream error." } });
    return;
  }
  const chat = JSON.parse(text);
  const message = chatToAnthropic(config, chat);
  if (payload.stream) streamAnthropic(res, message);
  else sendJson(res, 200, message);
}
```

- [ ] **Step 6: 运行测试验证通过**

Run: `node test/smoke.js`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add bin/llm-coding-bridge.js test/smoke.js
git commit -m "Emit response.failed on upstream error instead of silent completed"
```

### Task 1.3: 批次1 全量验证

- [ ] **Step 1: 跑全部质量门**

Run: `npm run lint && npm run security:scan && npm run secretlint && npm run repo:gate && npm test && npm run pack:check`
Expected: 全部 PASS

---

## 批次2：P1 稳定 + 安全

### Task 2.1: 客户端断开取消上游 reader

**Files:**
- Modify: `bin/llm-coding-bridge.js`（`handleChat` ~732-756，新增 `pipeStream`）
- Test: `test/smoke.js`

- [ ] **Step 1: 写失败测试 — 客户端断开后上游 reader 被 cancel**

在 `test/smoke.js` 的 `main()` 中插入。需要 mock 上游记录 reader 是否被 cancel。在 upstream server 创建处（smoke.js:67）增加一个 cancel 记录：

在 upstream server 的 `req.on("end", ...)` 之前，对 stream 响应记录 res，便于断言。简化做法：让 upstream 对 "long stream" 请求发一个不结束的 SSE 流，客户端断开后断言 upstream 连接被中断（upstream 的 res close 事件触发）。

```js
  // 客户端断开取消上游 reader
  let upstreamStreamClosed = false;
  const abortRes = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "long stream" }], stream: true }),
  });
  // 立即断开客户端
  abortRes.body.cancel();
  await wait(300);
  // upstream 对 "long stream" 返回不结束的流；客户端断开后 upstream res 应被关闭
  // 通过 upstreamRequests 不再增长间接验证（或直接记录）
  // 这里用 upstream server 侧记录：见 smoke.js upstream handler 增加 "long stream" 分支
```

需在 upstream handler（smoke.js:67-119）增加 "long stream" 分支：发一个 SSE chunk 后永不结束，监听 `res.on("close")` 设置 `upstreamStreamClosed = true`。在 `req.on("end")` 内：

```js
      if (prompt.includes("long stream")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        sse(res, { id: "chatcmpl-long", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "partial" } }] });
        res.on("close", () => { upstreamStreamClosed = true; });
        return;
      }
```

（放在 `const text = prompt.includes("exactly")...` 之前。）

然后断言：

```js
  assert.equal(upstreamStreamClosed, true, "upstream stream should be closed when client disconnects");
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node test/smoke.js`
Expected: FAIL — `upstreamStreamClosed` 为 false（当前 `handleChat` 不监听客户端 close，上游流不被取消，直到 600s timeout）。

- [ ] **Step 3: 实现 pipeStream 并用于 handleChat**

在 `bin/llm-coding-bridge.js` 的 `handleChat` 之前加入：

```js
async function pipeStream(upstreamBody, res) {
  const reader = upstreamBody.getReader();
  let aborted = false;
  const onClose = () => { aborted = true; reader.cancel().catch(() => {}); };
  res.on("close", onClose);
  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // abort 或写失败，静默
  } finally {
    res.off("close", onClose);
    if (!aborted) reader.cancel().catch(() => {});
  }
  res.end();
}
```

替换 `handleChat` 的流式分支（约第 744-756 行）为使用 `pipeStream`：

```js
async function handleChat(config, payload, res) {
  const upstreamPayload = { ...payload, model: config.upstream.model };
  const upstream = await fetchUpstream(config, upstreamPayload);
  if (!upstream.ok) {
    await upstream.text();
    sendJson(res, upstream.status, { error: { message: `Upstream HTTP ${upstream.status}.`, type: "upstream_error" } });
    return;
  }
  if (!payload.stream) {
    sendJson(res, upstream.status, await upstream.json());
    return;
  }
  res.writeHead(200, {
    "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  await pipeStream(upstream.body, res);
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node test/smoke.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add bin/llm-coding-bridge.js test/smoke.js
git commit -m "Cancel upstream reader when client disconnects during streaming"
```

### Task 2.2: 可选本地 token 鉴权

**Files:**
- Modify: `bin/llm-coding-bridge.js`（`loadConfig` ~53-64，`startServer` ~898-949，`initConfig` ~1138-1174）
- Modify: `templates/codex.config.toml`, `templates/codex-desktop.config.toml`, `templates/claude-code.env`
- Test: `test/smoke.js`

- [ ] **Step 1: 写失败测试 — 鉴权**

在 `test/smoke.js` 的 `main()` 中插入。新建一个带 localToken 的 bridge 实例：

```js
  // 可选本地 token 鉴权
  const authConfigPath = path.join(tmp, "auth.config.json");
  const authBridgePort = upstreamPort + 3;
  fs.writeFileSync(authConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: authBridgePort, localToken: "secret-token-xyz" },
    upstream: { name: "fake-upstream", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: "fake-model", apiKeyEnv: "FAKE_API_KEY" },
  }, null, 2));
  const authBridge = spawn(process.execPath, [cli, "serve", "--config", authConfigPath], {
    env: { ...process.env, FAKE_API_KEY: "upstream-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i += 1) {
    try {
      const h = await fetch(`http://127.0.0.1:${authBridgePort}/health`);
      if (h.status === 200) break;
    } catch {}
    await wait(100);
  }
  // /health 不鉴权
  const healthNoAuth = await fetch(`http://127.0.0.1:${authBridgePort}/health`);
  assert.equal(healthNoAuth.status, 200);
  // 无 token -> 401
  const noToken = await requestRaw(`http://127.0.0.1:${authBridgePort}/v1/chat/completions`, {
    model: "fake-model", messages: [{ role: "user", content: "hello" }], stream: false,
  });
  assert.equal(noToken.status, 401);
  // 错误 token -> 401
  const wrongToken = await requestRaw(`http://127.0.0.1:${authBridgePort}/v1/chat/completions`, {
    model: "fake-model", messages: [{ role: "user", content: "hello" }], stream: false,
  }, { Authorization: "Bearer wrong" });
  assert.equal(wrongToken.status, 401);
  // 正确 token (Bearer) -> 200
  const okBearer = await requestJson(`http://127.0.0.1:${authBridgePort}/v1/chat/completions`, {
    model: "fake-model", messages: [{ role: "user", content: "hello" }], stream: false,
  }, { Authorization: "Bearer secret-token-xyz" });
  assert.equal(okBearer.choices[0].message.content, "echo:hello");
  // 正确 token (x-api-key) -> 200
  const okApiKey = await requestJson(`http://127.0.0.1:${authBridgePort}/v1/chat/completions`, {
    model: "fake-model", messages: [{ role: "user", content: "hello" }], stream: false,
  }, { "x-api-key": "secret-token-xyz" });
  assert.equal(okApiKey.choices[0].message.content, "echo:hello");
  authBridge.kill("SIGTERM");
  await new Promise((resolve) => authBridge.on("close", resolve));
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node test/smoke.js`
Expected: FAIL — 当前不校验 token，无 token 请求返回 200。

- [ ] **Step 3: loadConfig 读取 localToken**

修改 `loadConfig`（第 56 行）的 server 解构：

```js
  const server = { host: "127.0.0.1", port: 18080, ...(config.server || {}) };
```

无需改（localToken 通过 spread 自动带入）。但需在 `startServer` 用到。

- [ ] **Step 4: startServer 加鉴权中间件**

在 `bin/llm-coding-bridge.js` 顶部 require 区加：

```js
const { randomUUID, timingSafeEqual } = require("node:crypto");
```

（替换原 `const { randomUUID } = require("node:crypto");`）

在 `startServer` 函数内、`http.createServer` 回调最前面（`try` 之后）加鉴权：

```js
function startServer(config) {
  const localToken = config.server.localToken || null;
  function authorized(req) {
    if (!localToken) return true;
    const auth = req.headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const xKey = req.headers["x-api-key"] || "";
    const candidate = bearer || xKey;
    if (!candidate || candidate.length !== localToken.length) return false;
    try {
      return timingSafeEqual(Buffer.from(candidate), Buffer.from(localToken));
    } catch {
      return false;
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || "/", `http://${config.server.host}:${config.server.port}`).pathname;
      if (req.method === "GET" && pathname === "/health") {
        debug("GET /health");
        sendJson(res, 200, { ok: true });
        return;
      }
      if (!authorized(req)) {
        sendJson(res, 401, { error: { message: "Unauthorized.", type: "auth_error" } });
        return;
      }
      // ... 其余路由不变
```

（`/health` 在鉴权之前，其余路由在鉴权之后。）

- [ ] **Step 5: initConfig 增加 localToken 提问**

在 `initConfig`（约第 1151 行 temperature 提问之后）加：

```js
    const localToken = valueOrDefault(await prompt.ask("Local auth token (optional, blank to disable) / 本地鉴权 token（可选，留空不启用）: "), "");
```

在 config 对象的 server 里加：

```js
    const config = {
      server: { host, port, ...(localToken ? { localToken } : {}) },
      upstream: { name, baseUrl, model, apiKeyEnv, temperature },
    };
```

- [ ] **Step 6: 更新模板占位说明**

`templates/codex.config.toml` 与 `templates/codex-desktop.config.toml` 的 `experimental_bearer_token = "local"` 改为：

```toml
experimental_bearer_token = "local"  # 若 bridge 配置了 localToken，改为该 token
```

`templates/claude-code.env` 的 `ANTHROPIC_API_KEY="local"` 改为：

```sh
ANTHROPIC_API_KEY="local"  # 若 bridge 配置了 localToken，改为该 token
```

- [ ] **Step 7: 运行测试验证通过**

Run: `node test/smoke.js`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add bin/llm-coding-bridge.js test/smoke.js templates/
git commit -m "Add optional local token auth with timing-safe comparison"
```

### Task 2.3: 批次2 全量验证

- [ ] **Step 1: 跑全部质量门**

Run: `npm run lint && npm run security:scan && npm run secretlint && npm run repo:gate && npm test && npm run pack:check`
Expected: 全部 PASS

---

## 批次3：P2 架构（拆分 + 多上游 + 优雅退出）

### Task 3.1: 拆分单文件到 lib/（纯重构）

**Files:**
- Create: `lib/config.js`, `lib/upstream.js`, `lib/converters/shared.js`, `lib/converters/responses.js`, `lib/converters/anthropic.js`, `lib/converters/chat.js`, `lib/server.js`, `lib/service.js`, `lib/doctor.js`, `lib/codex-profile.js`
- Modify: `bin/llm-coding-bridge.js`（瘦身为 CLI 入口）
- Modify: `package.json`（files 加 lib）

- [ ] **Step 1: 创建 lib/converters/shared.js**

把 `textFromContent`、`toolArgumentsString`、`parseToolArguments`、`toolInputFromArguments`、`parsedToolInput`、`approxTokens`、`anthropicText` 移入。每个函数原样搬移，文件末尾：

```js
module.exports = { textFromContent, toolArgumentsString, parseToolArguments, toolInputFromArguments, parsedToolInput, approxTokens, anthropicText };
```

- [ ] **Step 2: 创建 lib/config.js**

搬入 `loadConfig`、`resolveApiKey`、`getApiKey`、`apiKeyCache`、`DEFAULT_API_KEY_TTL_MS`、`upstreamUrl`、`localUrl`。导出：

```js
module.exports = { loadConfig, getApiKey, upstreamUrl, localUrl, DEFAULT_API_KEY_TTL_MS };
```

- [ ] **Step 3: 创建 lib/upstream.js**

搬入 `fetchUpstream`、`fetchUpstreamJson`、`pipeStream`、`eachSseData`。require `./config` 的 `getApiKey`、`upstreamUrl`。导出：

```js
module.exports = { fetchUpstream, fetchUpstreamJson, pipeStream, eachSseData };
```

- [ ] **Step 4: 创建 lib/converters/responses.js**

搬入 `responsesInputToMessages`、`convertTools`、`customToolNames`、`toolSearchNames`、`responsesToChatPayload`、`buildResponsesOutput`、`chatToResponse`、`ResponsesWriter`、`responseUsage`、`handleResponses`。require `./shared`、`../upstream`。导出 `handleResponses`、`responsesToChatPayload`、`chatToResponse`、`ResponsesWriter`。

- [ ] **Step 5: 创建 lib/converters/anthropic.js**

搬入 `anthropicToChatPayload`、`chatToAnthropic`、`streamAnthropic`、`handleAnthropicMessages`、`handleAnthropicTokenCount`。require `./shared`、`../upstream`。导出 `handleAnthropicMessages`、`handleAnthropicTokenCount`。

- [ ] **Step 6: 创建 lib/converters/chat.js**

搬入 `handleChat`。require `../upstream`。导出 `handleChat`。

- [ ] **Step 7: 创建 lib/server.js**

搬入 `startServer`、`sendJson`、`readJson`、`writeSse`、`debug`、`authorized`。require 各 converter 的 handler、`./config`。导出 `startServer`。

- [ ] **Step 8: 创建 lib/service.js**

搬入 `serviceLabel`、`plistPath`、`plistEscape`、`servicePath`、`installService`、`restartService`、`uninstallService`。导出这些函数。

- [ ] **Step 9: 创建 lib/doctor.js**

搬入 `doctor`、`deepDoctor`、`toolsDoctor`、`status`、`printCheck`、`packageVersion`、`fetchLocalJson`。require `./config`、`./upstream`、`./converters/responses`（chatToResponse）。导出 `doctor`、`status`。

- [ ] **Step 10: 创建 lib/codex-profile.js**

搬入 `loadCodexModelTemplate`、`codexCatalogModel`、`createCodexProfile`、`tomlString`、`writeChecked`。require `./config`（localUrl）。导出 `createCodexProfile`、`codexCatalogModel`。

- [ ] **Step 11: 瘦身 bin/llm-coding-bridge.js**

保留 `parseArgs`、`usage`、`main`、`printTemplate`、`printLogs`、`createPrompt`、`initConfig`、`valueOrDefault`。其余 require 自 lib。`initConfig` 里 `doctor(loadConfig(file))` 改为 `doctor(file)`（doctor 内部 loadConfig）。

- [ ] **Step 12: package.json files 加 lib**

`"files"` 数组加入 `"lib"`。

- [ ] **Step 13: 运行测试验证行为不变**

Run: `node test/smoke.js`
Expected: PASS（纯重构，行为零变化）

- [ ] **Step 14: 跑质量门**

Run: `npm run lint && npm run security:scan && npm run secretlint && npm run repo:gate && npm test && npm run pack:check`
Expected: 全部 PASS

- [ ] **Step 15: 提交**

```bash
git add bin/ lib/ package.json
git commit -m "Split single-file CLI into lib/ modules (pure refactor)"
```

### Task 3.2: 多上游 model 路由

**Files:**
- Modify: `lib/config.js`（`loadConfig` 解析 upstreams，新增 `resolveUpstream`）
- Modify: `lib/server.js`（路由查表，`/v1/models` 列出全部）
- Modify: `lib/converters/*.js`（handler 签名 `(upstream, payload, res)`）
- Test: `test/smoke.js`

- [ ] **Step 1: 写失败测试 — 多上游路由**

在 `test/smoke.js` 的 `main()` 中插入。建两个 upstream mock，不同 model 路由到不同 baseUrl：

```js
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
  const multiBridgePort = upstreamPort + 4;
  fs.writeFileSync(multiConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: multiBridgePort },
    upstreams: [
      { name: "u1", model: "model-a", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKeyEnv: "FAKE_API_KEY" },
      { name: "u2", model: "model-b", baseUrl: `http://127.0.0.1:${upstream2Port}/v1`, apiKeyEnv: "FAKE_API_KEY" },
    ],
  }, null, 2));
  const multiBridge = spawn(process.execPath, [cli, "serve", "--config", multiConfigPath], {
    env: { ...process.env, FAKE_API_KEY: "upstream-key" }, stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i += 1) {
    try { const h = await fetch(`http://127.0.0.1:${multiBridgePort}/health`); if (h.status === 200) break; } catch {}
    await wait(100);
  }
  const routeA = await requestJson(`http://127.0.0.1:${multiBridgePort}/v1/chat/completions`, {
    model: "model-a", messages: [{ role: "user", content: "hello" }], stream: false,
  });
  assert.equal(routeA.choices[0].message.content, "echo:hello");
  const routeB = await requestJson(`http://127.0.0.1:${multiBridgePort}/v1/chat/completions`, {
    model: "model-b", messages: [{ role: "user", content: "hello" }], stream: false,
  });
  assert.equal(routeB.choices[0].message.content, "from-upstream-2");
  // /v1/models 列出两个
  const multiModels = await fetch(`http://127.0.0.1:${multiBridgePort}/v1/models`, { headers: { Authorization: "Bearer test" } });
  const multiModelsBody = await multiModels.json();
  assert.equal(multiModelsBody.data.length, 2);
  multiBridge.kill("SIGTERM");
  await new Promise((resolve) => multiBridge.on("close", resolve));
  await new Promise((resolve) => upstream2.close(resolve));
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node test/smoke.js`
Expected: FAIL — 当前 `loadConfig` 不识别 `upstreams`，`startServer` 用 `config.upstream`，多上游配置会因缺 `upstream.baseUrl` 报错。

- [ ] **Step 3: lib/config.js 解析 upstreams + resolveUpstream**

修改 `loadConfig`，在返回前解析 upstreams：

```js
function loadConfig(file) {
  const configPath = path.resolve(file);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const server = { host: "127.0.0.1", port: 18080, ...(config.server || {}) };
  const single = config.upstream || null;
  const list = Array.isArray(config.upstreams) ? config.upstreams : [];
  if (!single && list.length === 0) throw new Error("Missing upstream or upstreams.");
  for (const u of [single, ...list].filter(Boolean)) {
    if (!u.baseUrl) throw new Error("Missing upstream.baseUrl.");
    if (!u.model) throw new Error("Missing upstream.model.");
    if (!u.apiKeyEnv && !u.apiKeyCommand) throw new Error("Missing upstream.apiKeyEnv or upstream.apiKeyCommand.");
  }
  const upstreams = list.length ? list : [single];
  return { path: configPath, server, upstreams, defaultUpstream: single || upstreams[0] };
}

function resolveUpstream(config, model) {
  if (model) {
    const hit = config.upstreams.find((u) => u.model === model);
    if (hit) return hit;
  }
  return config.defaultUpstream;
}

module.exports = { loadConfig, getApiKey, upstreamUrl, localUrl, resolveUpstream, DEFAULT_API_KEY_TTL_MS };
```

注意：`getApiKey` 的缓存 key 是 upstream 对象引用，多上游天然隔离。

- [ ] **Step 4: converter handler 签名改为 (upstream, payload, res)**

`lib/converters/chat.js` 的 `handleChat`：

```js
async function handleChat(upstream, payload, res) {
  const upstreamPayload = { ...payload, model: upstream.model };
  const response = await fetchUpstream({ upstream }, upstreamPayload);
  // ... 其余不变，config.upstream -> upstream
}
```

`fetchUpstream` 当前签名 `(config, payload)`，改为 `(upstream, payload)`：在 `lib/upstream.js`：

```js
async function fetchUpstream(upstream, payload) {
  const timeoutMs = Number(upstream.timeoutMs || 600000);
  // ... getApiKey(upstream), upstreamUrl(upstream)
}
```

所有调用点 `fetchUpstream(config, ...)` 改为 `fetchUpstream(upstream, ...)`，`fetchUpstreamJson` 同理。

`lib/converters/responses.js` 的 `handleResponses(upstream, payload, res)`、`responsesToChatPayload(upstream, payload)`、`chatToResponse(upstream, chat)`、`ResponsesWriter` 构造用 `upstream.model`。

`lib/converters/anthropic.js` 的 `handleAnthropicMessages(upstream, payload, res)`、`anthropicToChatPayload(upstream, payload)`、`chatToAnthropic(upstream, chat)`。

`lib/doctor.js` 的 `doctor`/`deepDoctor`/`toolsDoctor` 用 `config.defaultUpstream`。

- [ ] **Step 5: lib/server.js 路由查表**

`startServer` 内每个 POST 路由先 `const upstream = resolveUpstream(config, payload.model)`，再传给 handler。`/v1/models` 列出全部：

```js
      if (req.method === "GET" && pathname === "/v1/models") {
        const data = config.upstreams.map((u) => ({ id: u.model, object: "model", created: 0, owned_by: u.name || "upstream" }));
        const models = config.upstreams.map((u) => codexCatalogModel(u));
        sendJson(res, 200, { object: "list", data, models });
        return;
      }
```

`codexCatalogModel` 签名改为接收 upstream 对象（原接收 config，内部用 `config.upstream.*`，改为 `upstream.*`）。

- [ ] **Step 6: 运行测试验证通过**

Run: `node test/smoke.js`
Expected: PASS

- [ ] **Step 7: 跑质量门**

Run: `npm run lint && npm run security:scan && npm run secretlint && npm run repo:gate && npm test && npm run pack:check`
Expected: 全部 PASS

- [ ] **Step 8: 提交**

```bash
git add lib/ test/smoke.js
git commit -m "Support multiple upstreams with model-based routing"
```

### Task 3.3: 优雅退出 SIGTERM

**Files:**
- Modify: `lib/server.js`（`startServer` 注册信号 handler，维护进行中 res 集合）
- Test: `test/smoke.js`

- [ ] **Step 1: 写失败测试 — SIGTERM 终止进行中流式响应**

在 `test/smoke.js` 的 `main()` 中插入：

```js
  // 优雅退出：SIGTERM 终止进行中流式响应
  const graceConfigPath = path.join(tmp, "grace.config.json");
  const graceBridgePort = upstreamPort + 5;
  fs.writeFileSync(graceConfigPath, JSON.stringify({
    server: { host: "127.0.0.1", port: graceBridgePort },
    upstream: { name: "fake-upstream", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, model: "fake-model", apiKeyEnv: "FAKE_API_KEY" },
  }, null, 2));
  const graceBridge = spawn(process.execPath, [cli, "serve", "--config", graceConfigPath], {
    env: { ...process.env, FAKE_API_KEY: "upstream-key" }, stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 50; i += 1) {
    try { const h = await fetch(`http://127.0.0.1:${graceBridgePort}/health`); if (h.status === 200) break; } catch {}
    await wait(100);
  }
  // 发起一个流式请求（upstream 对 "long stream" 返回不结束的流）
  const graceStreamRes = await fetch(`http://127.0.0.1:${graceBridgePort}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ model: "fake-model", input: "long stream", stream: true }),
  });
  const reader = graceStreamRes.body.getReader();
  const firstChunk = await reader.read();
  // 发 SIGTERM
  graceBridge.kill("SIGTERM");
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value).toString("utf8"));
    }
  } catch {}
  const fullStream = firstChunk.value ? Buffer.from(firstChunk.value).toString("utf8") + chunks.join("") : chunks.join("");
  assert.match(fullStream, /response\.failed|event: error|\[DONE\]/);
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node test/smoke.js`
Expected: FAIL — 当前 SIGTERM 直接杀进程，流式响应被硬断，客户端读到不完整内容且无 failed 帧（或 fetch 抛错）。

- [ ] **Step 3: 实现 graceful shutdown**

在 `lib/server.js` 的 `startServer` 内：

```js
function startServer(config) {
  const activeStreams = new Set();
  function registerStream(res) { activeStreams.add(res); res.on("close", () => activeStreams.delete(res)); }
  function shutdown() {
    for (const res of activeStreams) {
      if (!res.writableEnded) {
        try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  }
  const server = http.createServer(async (req, res) => {
    // ... 流式 handler 在 writeHead 后调用 registerStream(res)
  });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  server.listen(...);
  return server;
}
```

在 `handleChat`/`handleResponses`/`streamAnthropic` 的流式 `writeHead` 之后调用 `registerStream(res)`。需把 `registerStream` 传入或作为模块级（用闭包）。简单做法：`startServer` 内定义 `registerStream`，handler 改为接收额外参数，或在 server 回调里包一层。

实现：server 回调里，对返回流式的路由，在调用 handler 前无法预知是否流式。改为在 `res` 上挂钩：`res.on("pipe", ...)` 不可靠。最简：每个流式 handler 内部 `writeHead` 后调用全局 `registerStream`。把 `registerStream` 放 `lib/server.js` 模块级，`startServer` 设置当前集合：

```js
let activeStreams = null;
function registerStream(res) {
  if (!activeStreams) return;
  activeStreams.add(res);
  res.on("close", () => activeStreams.delete(res));
}
```

各 converter 的流式 handler require `registerStream` from `./server`。为避免循环依赖，把 `registerStream` 放 `lib/upstream.js`（或新建 `lib/streams.js`）。新建 `lib/streams.js`：

```js
let activeStreams = null;
function setActive(s) { activeStreams = s; }
function registerStream(res) {
  if (!activeStreams) return;
  activeStreams.add(res);
  res.on("close", () => activeStreams.delete(res));
}
module.exports = { setActive, registerStream };
```

`lib/server.js` 的 `startServer` 创建 `activeStreams = new Set()` 后 `setActive(activeStreams)`。各流式 handler `require("../streams").registerStream` 并在 `writeHead` 后调用。

- [ ] **Step 4: 运行测试验证通过**

Run: `node test/smoke.js`
Expected: PASS

- [ ] **Step 5: 跑质量门**

Run: `npm run lint && npm run security:scan && npm run secretlint && npm run repo:gate && npm test && npm run pack:check`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add lib/ test/smoke.js
git commit -m "Graceful shutdown on SIGTERM/SIGINT with stream termination"
```

---

## 批次4：P3 防御

### Task 4.1: 请求体大小限制

**Files:**
- Modify: `lib/server.js`（`readJson` 加 maxBodyBytes）
- Test: `test/smoke.js`

- [ ] **Step 1: 写失败测试 — 超限 body 返回 413**

在 `test/smoke.js` 的 `main()` 中插入：

```js
  // 请求体大小限制
  const bigBody = JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "x".repeat(11 * 1024 * 1024) }], stream: false });
  const bigRes = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: bigBody,
  });
  assert.equal(bigRes.status, 413);
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node test/smoke.js`
Expected: FAIL — 当前无限制，返回 200（或上游处理）。

- [ ] **Step 3: readJson 加大小限制**

`lib/server.js` 的 `readJson`：

```js
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
async function readJson(req, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      req.destroy();
      const err = new Error("Payload too large.");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
```

`startServer` 内 `server.maxBodyBytes` 传入。调用点改为 `await readJson(req, config.server.maxBodyBytes || DEFAULT_MAX_BODY_BYTES)`。

顶层 catch 区分 413：

```js
    } catch (error) {
      if (error.statusCode === 413) sendJson(res, 413, { error: { message: "Payload too large.", type: "payload_too_large" } });
      else sendJson(res, 500, { error: { message: "Bridge request failed.", type: "bridge_error" } });
    }
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node test/smoke.js`
Expected: PASS

- [ ] **Step 5: 跑质量门**

Run: `npm run lint && npm run security:scan && npm run secretlint && npm run repo:gate && npm test && npm run pack:check`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add lib/ test/smoke.js
git commit -m "Enforce request body size limit (default 10MB)"
```

---

## 发布

### Task 5.1: 更新 README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 加多上游配置示例、localToken 说明、新文件结构**

在 README "Configure" 节加多上游示例：

```json
{
  "server": { "host": "127.0.0.1", "port": 18080, "localToken": "your-secret" },
  "upstreams": [
    { "name": "OpenAI", "model": "gpt-4o", "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" },
    { "name": "Other", "model": "other-model", "baseUrl": "https://api.other.com/v1", "apiKeyEnv": "OTHER_API_KEY" }
  ]
}
```

加 localToken 说明：配置后请求须带 `Authorization: Bearer <token>` 或 `x-api-key: <token>`，绑非 loopback 时强烈建议。

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "Document multi-upstream routing and local token auth"
```

### Task 5.2: 版本 bump 与发布

**Files:**
- Modify: `package.json`（version 0.1.10 → 0.2.0）

- [ ] **Step 1: bump 版本**

`package.json` 的 `"version": "0.1.10"` 改为 `"0.2.0"`。

- [ ] **Step 2: 最终全量验证**

Run: `npm run lint && npm run security:scan && npm run secretlint && npm run repo:gate && npm run sca && npm test && npm run pack:check`
Expected: 全部 PASS

- [ ] **Step 3: 提交并打 tag**

```bash
git add package.json
git commit -m "Release 0.2.0"
git tag v0.2.0
```

- [ ] **Step 4: 推送触发发布（发布前与用户确认）**

```bash
git push origin main --tags
```

push 后 `publish.yml` 工作流自动发布到 npm（provenance）。发布前停下与用户确认。

---

## Self-Review

**Spec coverage:**
- 1.1 apiKeyCommand 缓存 → Task 1.1 ✓
- 1.2 流式异常发 failed → Task 1.2 ✓
- 2.1 客户端断开取消 reader → Task 2.1 ✓
- 2.2 可选 token 鉴权 → Task 2.2 ✓
- 3.1 多上游 model 路由 → Task 3.2 ✓
- 3.2 优雅退出 → Task 3.3 ✓
- 文件拆分 → Task 3.1 ✓
- 4.1 请求体限制 → Task 4.1 ✓
- 发布 → Task 5.1/5.2 ✓

**Placeholder scan:** 无 TBD/TODO，每步含具体代码。

**Type consistency:** `fetchUpstream`/`fetchUpstreamJson` 签名 `(config, payload)` → `(upstream, payload)` 在 Task 3.2 统一改。converter handler 签名 `(config, payload, res)` → `(upstream, payload, res)` 一致。`resolveUpstream`、`registerStream`、`setActive` 定义与调用一致。
