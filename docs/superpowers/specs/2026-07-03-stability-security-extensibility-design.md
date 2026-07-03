# llm-coding-bridge 稳定性 / 安全 / 可扩展改造设计

日期：2026-07-03
状态：已与用户对齐，待实施

## 背景与动机

`@sevoniva/llm-coding-bridge` 是单文件（1284 行）本地协议翻译代理，把 OpenAI-compatible `/chat/completions` 上游接入 Codex（`/v1/responses`）、Claude 类客户端（`/v1/messages`）和 OpenAI-compatible 客户端（`/v1/chat/completions`）。

当前存在三类问题：

- **稳定性**：`apiKeyCommand` 每次请求都 spawn 进程；上游流式异常时仍发 `response.completed`，静默截断；客户端断开不取消上游 reader，连接泄漏到 600s timeout；无优雅退出。
- **安全**：`Bearer local` 是占位符、服务端完全不校验，绑非 loopback 或同机其他用户可白嫖上游 key。
- **可扩展**：只支持单上游，无法按 model 路由；单文件 1284 行难以继续扩展。

## 目标

生产级标准，分批实施，最终发布到 npm。

## 非目标

- 跨平台服务安装（Windows schtasks / Linux systemd）本次不做，记为 future work。
- 不引入运行时依赖（保持零依赖）。
- 不改 `test/smoke.js` 的端到端测试范式（仍通过 CLI 验证）。

## 架构：文件拆分

将 `bin/llm-coding-bridge.js` 拆为：

```
bin/llm-coding-bridge.js      # CLI 入口 + parseArgs + main（薄）
lib/config.js                 # loadConfig, getApiKey（含缓存）, 配置校验
lib/server.js                 # startServer, 路由分发, 鉴权中间件, 请求体限制, 优雅退出
lib/upstream.js               # fetchUpstream, fetchUpstreamJson, pipeStream（断开取消）
lib/converters/
  responses.js                # responsesInputToMessages, ResponsesWriter, handleResponses
  anthropic.js                # anthropicToChatPayload, chatToAnthropic, streamAnthropic, handleAnthropicMessages
  chat.js                     # handleChat（透传）
  shared.js                   # textFromContent, toolArgumentsString 等共享工具
lib/service.js                # installService, restartService, uninstallService, plist
lib/doctor.js                 # doctor, deepDoctor, toolsDoctor, status
lib/codex-profile.js          # createCodexProfile, codexCatalogModel, loadCodexModelTemplate
```

拆分原则：纯移动 + `require`，行为零变化。`package.json` 的 `files` 字段加入 `lib`。

关键边界：
- `lib/upstream.js` 持有 apiKey 缓存。
- `lib/server.js` 持有鉴权中间件、请求体限制、优雅退出、多上游路由查表。
- 转换器是无状态纯函数 + 各自 handler，接收选中的 `upstream` 对象（而非全局 config）。

## 批次1：P0 稳定性

### 1.1 apiKeyCommand 缓存

**问题**：`getApiKey()` 每次请求 `spawnSync`，Codex 一次会话几十次敲 Keychain，慢且高频 spawn。

**设计**：`lib/config.js` 模块级缓存。
- 首次调用执行 command，结果存内存 `{ value, ts }`。
- 后续请求直接返回缓存值。
- TTL 默认 10 分钟，可由 `upstream.apiKeyCacheTtlMs` 覆盖。Keychain token 不频繁变，但轮换后能自愈。
- `apiKeyEnv` 模式：env 变量是进程级常量，读 `process.env` 近零成本，但为统一也走缓存层。
- 失败不缓存，抛错照旧。

多上游场景下缓存按 upstream 引用隔离（见 3.1）。

### 1.2 流式异常发 failed 而非 completed

**问题**：`handleResponses` 上游 `!ok` 或 SSE 中途断开时仍发 `response.completed`，客户端以为成功但内容截断。

**设计**：`ResponsesWriter` 增加 `fail(error)` 方法。
- 上游 `!ok`：已发 `response.created` + `response.in_progress`，此时发 `response.failed` 事件 + `data: [DONE]`，status 设 `failed`。
- SSE 读取抛错（`reader.read()` reject）：同上，发 `response.failed`。
- `failed` 事件体：`{ type: "response.failed", response: { ...this.response("failed"), error: { message: "Upstream error.", code: "upstream_error" } } }`。
- 错误消息固定文案，不回显上游内容（沿用现有 redact 策略）。
- 非流式模式：上游 `!ok` 直接 `sendJson` 返回错误（现状已对）；SSE 读取异常时改走 `fail()` 而非 `complete()`。

`handleChat` 透传模式：上游 `!ok` 已正确返回错误状态。流式透传中途断开是透传固有行为，不改（无法构造 failed 帧）。

`handleAnthropicMessages`：当前用 `fetchUpstreamJson`，上游 `!ok` 抛错被顶层 catch 吞成 500。改为上游 `!ok` 时返回 Anthropic 格式错误体 `{ type: "error", error: { type: "api_error", message: "Upstream error." } }`，状态码透传上游的。

## 批次2：P1 稳定 + 安全

### 2.1 客户端断开取消上游 reader

**问题**：流式时客户端断开，`res.write` 抛错或静默失败，上游 reader 不取消，连接泄漏到 timeout。

**设计**：`lib/upstream.js` 的 `pipeStream(upstreamBody, res, onDone)` 统一流式透传：
- 监听 `res.on("close")` 触发 `AbortController.abort()`，中断 `reader.read()`。
- abort 或写失败时静默退出。
- finally 中 `reader.cancel()`、移除 listener、调用 `onDone`。

`handleChat` 透传改用 `pipeStream`。`handleResponses` 的 `eachSseData` 接收 abort signal，中断时停止解析并走 `writer.fail()`。

### 2.2 可选本地 token 鉴权

**问题**：`Bearer local` 占位符不校验，绑 `0.0.0.0` 或同机其他用户可白嫖上游 key。

**设计**：`lib/config.js` 读取 `server.localToken`（可选字符串）。`lib/server.js` 加鉴权中间件：
- 配置了 `localToken`：请求必须带 `Authorization: Bearer <token>` 或 `x-api-key: <token>` 之一匹配，否则 401。
- 未配置：保持现状不校验（向后兼容）。
- `/health` 不鉴权（健康探测不带 token）。
- token 用 `crypto.timingSafeEqual` 常量时间比较，防时序攻击。比较前先校验长度一致，长度不同直接 401（不泄露长度信息外的内容）。
- `init` 向导增加一问 "Local auth token (optional)"，留空则不启用。
- Codex/Claude 模板里 `experimental_bearer_token` / `ANTHROPIC_API_KEY` 改为占位说明：用实际 token 替换 `local`。

文档强调：绑非 loopback 时强烈建议配置 token。

## 批次3：P2 架构

### 3.1 多上游 model 路由

**配置结构**（向后兼容）：
```json
{
  "server": { "host", "port", "localToken", "maxBodyBytes" },
  "upstream": { "name", "baseUrl", "model", "apiKeyEnv"|"apiKeyCommand", "temperature", "reasoningEffort", "contextWindow", "apiKeyCacheTtlMs" },
  "upstreams": [
    { "name", "model", "baseUrl", "apiKeyEnv"|"apiKeyCommand", "temperature", "reasoningEffort", "contextWindow", "apiKeyCacheTtlMs" }
  ]
}
```

`upstream`（单上游）与 `upstreams`（多上游）二选一；同时存在时 `upstreams` 优先，`upstream` 作为 default fallback。

**路由规则**（`lib/server.js`）：
- 客户端请求的 `model` 字段查 `upstreams[].model`，命中则用该上游。
- 未命中：回退到 `upstream`（单上游兼容）或 `upstreams[0]`。
- converter 签名从 `(config, payload, res)` 改为 `(upstream, payload, res)`，接收选中的 upstream 对象。
- `/v1/models` 列出所有 upstreams 的 model（`data` 数组 + `models` catalog 数组）。
- apiKey 缓存按 upstream 隔离：`Map<upstreamRef, {value, ts}>`，每个上游独立 TTL。

### 3.2 优雅退出 SIGTERM

**设计**：`lib/server.js` 的 `startServer` 注册 `SIGTERM`/`SIGINT` handler：
- `server.close()` 停止接受新连接。
- 对所有进行中的流式 `res` 发终止帧：Responses 发 `response.failed`，Anthropic 发 `event: error`，Chat 透传直接 `res.end()`。
- 等待进行中请求结束或 5s 超时硬退（`process.exit(0)`）。
- launchd `bootout` 发 SIGTERM，`restart-service` 由此平滑。

需维护一个 `Set<res>` 跟踪进行中的流式响应。

## 批次4：P3 防御

### 4.1 请求体大小限制

**设计**：`lib/server.js` 的 `readJson` 加 `maxBodyBytes`（默认 10MB，可配 `server.maxBodyBytes`）。读取时累计字节数，超限返回 413 并销毁 socket。Codex 大 context 偶尔接近但不会超 10MB。

## Future Work

- 跨平台服务安装：Windows schtasks、Linux systemd。当前 macOS launchd 不变。
- 请求/响应中间件 hook（日志、计费、redact），当前不引入。
- Gemini 协议支持，当前不引入。

## 测试策略

- `test/smoke.js` 扩展覆盖：
  - apiKeyCommand 缓存：mock command，断言只 spawn 一次（多次请求后调用计数为 1）。
  - 流式异常：上游返回 `!ok`，断言收到 `response.failed` 而非 `response.completed`。
  - 客户端断开：发起流式请求后立即断开，断言上游 reader 被 cancel（mock 上游记录读取次数）。
  - 鉴权：配置 localToken，无 token 请求 401，正确 token 200，错误 token 401；`/health` 不鉴权。
  - 多上游路由：配置两个 upstreams，不同 model 请求路由到不同上游（mock 上游记录收到的 baseUrl）。
  - 优雅退出：发 SIGTERM，断言进行中流式响应收到终止帧。
  - 请求体限制：发 11MB body，断言 413。
- 现有 smoke 测试全部保持通过（向后兼容）。
- `npm run lint` / `security:scan` / `secretlint` / `repo:gate` / `sca` / `pack:check` 全部通过。

## 发布

- 版本号 bump（0.1.10 → 0.2.0，含架构变更属 minor）。
- 更新 README：多上游配置示例、localToken 说明、新文件结构。
- 打 tag `v0.2.0`，触发 `publish.yml` 工作流发布到 npm（provenance，id-token）。
- 发布前与用户确认。
