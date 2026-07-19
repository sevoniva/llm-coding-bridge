# @sevoniva/llm-coding-bridge

Local bridge for using an OpenAI-compatible `/chat/completions` provider with coding clients that expect OpenAI-style endpoints.

It exposes:

- `/v1/responses` for Codex CLI and Codex Desktop
- `/v1/messages` for Claude-compatible clients
- `/v1/chat/completions` for OpenAI-compatible clients
- `/v1/models` and `/health` for client checks

The bridge is designed for a dedicated upstream connection: one local endpoint for Codex, Claude Code, and OpenAI-compatible clients.

## Install

```bash
npm install -g @sevoniva/llm-coding-bridge
```

Or run with npx:

```bash
npx @sevoniva/llm-coding-bridge init
```

## Configure

Run the bilingual setup guide:

```bash
llm-coding-bridge init
```

The config is written to `~/.llm-coding-bridge/config.json` by default (override with `--out`). All commands read that file by default; a `llm-coding-bridge.config.json` in the current directory takes precedence, and `--config` overrides both.

### Port migration in v0.5.0

New configurations use port `37629` by default. The port remains configurable and is not reserved exclusively for this project.

Package upgrades do not rewrite existing configuration files. To move an existing installation from `18080` to `37629`:

1. Set `server.port` to `37629` in the bridge config.
2. Update each client Base URL to use port `37629`.
3. Run `llm-coding-bridge restart-service`, then verify `http://127.0.0.1:37629/health`.

### Security boundaries in v0.6.0

- A non-loopback `server.host` now requires `server.localToken`; unsafe configurations are rejected before the service starts.
- Configs, client profiles, and their backups written by the CLI use mode `0600`. Newly created private config directories use mode `0700`.
- Existing symbolic links used for client configuration are preserved; the resolved regular-file target is updated atomically and restricted to mode `0600`.
- The upstream deadline covers the complete response body. Responses are capped at 32 MiB and individual SSE events at 1 MiB by default.
- Streaming honors downstream backpressure, limits each drain wait to 30 seconds, and accepts both LF and CRLF SSE framing.
- POST API routes require `application/json` and reject browser requests from non-loopback origins. CLI and desktop clients that do not send an `Origin` header remain compatible.
- GitHub Actions used by CI and package publication are pinned to verified commit SHAs.

Package upgrades do not rewrite existing local files. For an existing installation, review secret-bearing files once with `chmod 600 <file>`.

The guide asks for the local listen address, local port, upstream Base URL, upstream model, API key source, temperature, and optional client setup:

```text
Listen host / 本地监听地址 [127.0.0.1]:
Listen port / 本地监听端口 [37629]:
Provider name / 上游服务名称 [Custom Provider]:
Upstream base URL / 上游 Base URL:
Upstream model / 上游模型名称:
API key source (local/client) / API Key 来源（local/client）[local]:
API key environment variable / API Key 环境变量 [LLM_API_KEY]:
API key command (optional) / API Key 读取命令（可选）:
Temperature / 采样温度 [0]:
Local auth token (required for non-loopback hosts) / 本地鉴权 token（非 loopback 必填）:
Configure local clients now? / 是否现在配置本地客户端？[y/N]:
```

Use `local` when the bridge reads the upstream key from an environment variable or command. Use `client` when a local provider switcher manages the key and sends it with each request.

Client setup defaults to `No`. When enabled, the guide can update Claude Code settings, generate an isolated Codex CLI profile, or configure Codex Desktop after a separate confirmation. Existing files are backed up first with `.bak-YYYYMMDD-HHMMSS`.

The bridge config does not store an upstream API key. In client-key mode, generated Claude or Codex client configuration may store that key as the client bearer token; generated files and backups use mode `0600`.

For complete setup instructions, see [Configuration Guide](docs/configuration.md).

The generated file looks like this:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 37629
  },
  "upstream": {
    "name": "Custom Provider",
    "baseUrl": "https://api.example.com/v1",
    "model": "model-name",
    "apiKeyEnv": "LLM_API_KEY",
    "temperature": 0
  }
}
```

Upstream API keys are not stored in the bridge config:

```bash
export LLM_API_KEY="..."
```

Client-managed key mode writes this instead:

```json
{
  "upstream": {
    "name": "Custom Provider",
    "baseUrl": "https://api.example.com/v1",
    "model": "model-name",
    "apiKeySource": "client",
    "temperature": 0
  }
}
```

## Multiple upstreams

Route requests to different providers by the `model` field the client sends. Use `upstreams` instead of `upstream`:

```json
{
  "server": { "host": "127.0.0.1", "port": 37629 },
  "upstreams": [
    { "name": "OpenAI", "model": "gpt-4o", "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" },
    { "name": "Other", "model": "other-model", "baseUrl": "https://api.other.com/v1", "apiKeyEnv": "OTHER_API_KEY" }
  ]
}
```

A request with `model: "gpt-4o"` routes to OpenAI; `model: "other-model"` routes to Other. With multiple upstreams configured, a model that matches none of them returns `404 model_not_found` rather than silently routing to the wrong provider. With a single `upstream`, the client's model field is rewritten to the configured one (backward compatible). `/v1/models` lists all configured models.

## Local auth

By default the bridge listens on `127.0.0.1` and does not require auth. Set `server.localToken` to require a token. A non-loopback host is rejected unless this value is configured:

```json
{
  "server": { "host": "127.0.0.1", "port": 37629, "localToken": "your-secret" }
}
```

Clients must then send `Authorization: Bearer your-secret` or `x-api-key: your-secret`. `/health` remains unauthenticated. Comparison is constant-time.

## Upstream response limits

`upstream.timeoutMs` applies to the complete upstream response, including streaming bodies. The default is 10 minutes. `upstream.maxResponseBytes` defaults to 32 MiB, and `upstream.maxSseEventBytes` defaults to 1 MiB:

```json
{
  "upstream": {
    "timeoutMs": 600000,
    "maxResponseBytes": 33554432,
    "maxSseEventBytes": 1048576
  }
}
```

All three values must be positive integers. The response limit is cumulative across JSON, raw streaming, and parsed SSE modes.

## API key caching

`apiKeyCommand` results are cached in-process for 10 minutes by default to avoid spawning a command on every request. Override with `upstream.apiKeyCacheTtlMs`; set it to `0` to disable caching and resolve the key on every request. Each upstream in a multi-upstream config has an independent cache. If the upstream returns `401`, the cached key is dropped immediately so the next request re-resolves — this lets a rotated key recover without restarting the bridge.

To let a client-side router manage upstream keys, set `apiKeySource` to `client` and remove `apiKeyEnv` / `apiKeyCommand`:

```json
{
  "upstream": {
    "name": "Custom Provider",
    "baseUrl": "https://api.example.com/v1",
    "model": "model-name",
    "apiKeySource": "client"
  }
}
```

The bridge forwards the client request key to the upstream. It reads `x-upstream-api-key` first, then `Authorization: Bearer ...`, then `x-api-key`. This is useful when tools such as provider switchers own the real upstream key. If `server.localToken` is enabled, send the local token in `Authorization` and the upstream key in `x-upstream-api-key`.

For generated Codex or Claude configs in client-key mode, set the client token to the real upstream key, or let the provider switcher manage the client config. To run `doctor` with `apiKeySource: "client"`, provide a probe key:

```bash
LLM_CODING_BRIDGE_CLIENT_API_KEY="..." llm-coding-bridge doctor
```

For background services, prefer a command-backed key so launchd does not depend on shell environment variables:

```json
{
  "upstream": {
    "apiKeyCommand": {
      "command": "/usr/bin/security",
      "args": ["find-generic-password", "-a", "LLM_API_KEY", "-s", "llm-coding-bridge", "-w"]
    }
  }
}
```

## ZCode and provider compatibility

OpenAI-compatible endpoints do not always handle client extension fields and non-streaming responses consistently. The bridge provides compatibility handling for ZCode and other OpenAI-compatible clients.

Enable request cleanup when an upstream rejects `chat_template_kwargs`:

```json
{
  "upstream": {
    "stripChatTemplateKwargs": true
  }
}
```

This option removes `chat_template_kwargs` from the top-level request and from `extra_body.chat_template_kwargs`. All other request fields are preserved.

For a non-streaming request, the bridge also accepts an upstream response delivered as a complete SSE sequence and converts it into a standard OpenAI `chat.completion` JSON object. This keeps ZCode context compaction and other `stream: false` workflows compatible with endpoints that use SSE framing for non-streaming responses. Response normalization is limited to non-streaming requests; streaming response bodies pass through unchanged. Request cleanup applies to both modes when enabled.

### Streaming keepalive and sleep/wake recovery

For OpenAI Chat Completions with `stream: true`, the bridge commits SSE headers immediately and emits a protocol-valid empty `chat.completion.chunk` after each idle `server.heartbeatIntervalMs` (default `15000`; `0` disables). The idle timer resets whenever a real upstream chunk arrives and continues for later gaps, so ZCode sees model data activity both before the first upstream byte and during long mid-stream pauses. Responses keeps its immediate `response.created` / `response.in_progress` events plus comment heartbeat, and Anthropic keeps its comment heartbeat while its upstream response is buffered.

Closing a MacBook lid suspends the local bridge and normally breaks open TCP streams; no local process can keep executing while macOS is in clamshell sleep. After wake, an upstream Chat transport failure is exposed as a downstream connection failure so ZCode can apply its normal request retry policy. The bridge does not disable macOS sleep and does not replay a partially consumed request, which avoids duplicate model work or billing. An upstream HTTP response, empty body, or non-SSE streaming response is still reported as an in-stream SSE error followed by `data: [DONE]` because those are protocol responses rather than transport failures.

## Run

```bash
llm-coding-bridge doctor
llm-coding-bridge doctor --tools
llm-coding-bridge serve
```

Then point clients at:

```text
http://127.0.0.1:37629/v1
```

For a local service check that does not call the upstream model:

```bash
llm-coding-bridge status
```

`doctor --tools` verifies Codex-style function, freeform, and tool-search calls through the bridge.

## Codex

Print the Codex template:

```bash
llm-coding-bridge template codex
```

Minimal Codex config:

```toml
model = "your-model"
model_provider = "llm-coding-bridge"
model_reasoning_effort = "none"
disable_response_storage = true
# `llm-coding-bridge codex-profile` generates model_catalog_json automatically.

[model_providers.llm-coding-bridge]
name = "LLM Coding Bridge"
base_url = "http://127.0.0.1:37629/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"  # use server.localToken, or the upstream key when apiKeySource=client
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

Use this as a separate Codex profile if you do not want to change your default Codex Desktop setup.

For Codex CLI, generate a separate profile:

```bash
llm-coding-bridge codex-profile --name bridge
codex --profile bridge exec --skip-git-repo-check "Reply exactly: OK"
```

Use `--force` to overwrite an existing generated profile. Existing generated files are backed up first.

The check should show:

```text
provider: llm-coding-bridge
```

If it shows `provider: openai`, Codex did not load the profile. Confirm the file is named exactly `~/.codex/bridge.config.toml`.

For Codex Desktop, keep the bridge running in the background. On macOS, install the launchd service:

```bash
llm-coding-bridge install-service
curl http://127.0.0.1:37629/health
```

Then back up `~/.codex/config.toml`, place the same provider block and top-level `model` / `model_provider` values in `~/.codex/config.toml`, and restart Codex Desktop. The `init` guide can do this after an explicit Desktop confirmation.

Print the Codex Desktop template:

```bash
llm-coding-bridge template codex-desktop
```

Use this when you want the bridge as the default provider for Codex Desktop and for CLI sessions that do not pass `--profile`.

## Claude

Print the Claude template:

```bash
llm-coding-bridge template claude
```

Use the local Anthropic-compatible endpoint:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:37629"
export ANTHROPIC_AUTH_TOKEN="local"
export ANTHROPIC_DEFAULT_SONNET_MODEL="your-model"
export ANTHROPIC_DEFAULT_OPUS_MODEL="your-model"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="your-model"
```

The bridge exposes `/v1/messages` and `/v1/messages/count_tokens`.

Persistent Claude Code settings can be written by `init`. If `~/.claude/settings.json` exists, it is backed up before the `env` object is merged.

For an isolated Claude Code check that does not read existing user settings:

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:37629" \
ANTHROPIC_AUTH_TOKEN="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

## macOS autostart

```bash
llm-coding-bridge install-service
```

Restart it after package or config changes:

```bash
llm-coding-bridge restart-service
```

Remove it:

```bash
llm-coding-bridge uninstall-service
```

Logs are written to:

```text
~/.llm-coding-bridge/logs/
```

Print recent logs:

```bash
llm-coding-bridge logs --lines 80
```

## 中文说明

`@sevoniva/llm-coding-bridge` 是一个本地 Node 中转服务，用于把 OpenAI-compatible `/chat/completions` 上游接入 Codex CLI、Codex Desktop 和 Claude 类客户端。

它提供：

- `/v1/responses`：给 Codex 使用
- `/v1/messages`：给 Claude 类客户端使用
- `/v1/chat/completions`：给 OpenAI-compatible 客户端使用
- `/v1/models` 和 `/health`：用于客户端检测

它面向专用上游连接：用一个本地端点同时服务 Codex、Claude Code 和 OpenAI-compatible 客户端。

安装：

```bash
npm install -g @sevoniva/llm-coding-bridge
```

生成配置：

```bash
llm-coding-bridge init
```

配置默认写入 `~/.llm-coding-bridge/config.json`（可用 `--out` 覆盖）。所有命令默认读取该文件；当前目录存在 `llm-coding-bridge.config.json` 时优先使用，`--config` 优先级最高。

### v0.5.0 端口迁移

新生成的配置默认使用端口 `37629`。该端口仍可配置，项目不声明独占此端口。

升级软件包不会改写已有配置。将现有安装从 `18080` 迁移到 `37629` 时：

1. 在 bridge 配置中把 `server.port` 改为 `37629`。
2. 将各客户端 Base URL 的端口同步改为 `37629`。
3. 执行 `llm-coding-bridge restart-service`，再访问 `http://127.0.0.1:37629/health` 验证服务。

### v0.6.0 安全边界

- `server.host` 使用非 loopback 地址时必须配置 `server.localToken`，否则服务拒绝启动。
- CLI 写入的配置、客户端 profile 及备份固定为 `0600`；新建的私有配置目录为 `0700`。
- 如果客户端配置使用符号链接，bridge 会保留链接，原子更新其指向的普通文件，并将目标文件权限收紧为 `0600`。
- 上游超时覆盖完整响应正文。响应总量默认上限 32 MiB，单个 SSE 事件默认上限 1 MiB。
- 流式转发遵循下游背压，单次 drain 等待上限为 30 秒，并同时支持 LF 与 CRLF SSE 分帧。
- POST API 只接受 `application/json`，并拒绝来自非 loopback Origin 的浏览器请求；不发送 `Origin` 的 CLI 和桌面客户端保持兼容。
- CI 和 npm 发布工作流使用已验证的完整 commit SHA。

升级软件包不会改写已有本地文件。已有安装应对包含凭据的文件执行一次 `chmod 600 <file>` 检查。

`init` 会在 bridge 配置和检测之后询问是否配置 Claude Code、Codex CLI profile 和 Codex Desktop。默认不写客户端配置；确认写入前会先备份已有文件，备份后缀为 `.bak-YYYYMMDD-HHMMSS`。Codex Desktop 会改变默认 provider，需要单独确认。

bridge 配置不保存上游 API Key。在 client key 模式下，自动生成的 Claude 或 Codex 客户端配置可能把真实上游 Key 保存为客户端 bearer token；生成文件和备份使用 `0600` 权限。

检测配置：

```bash
export LLM_API_KEY="..."
llm-coding-bridge doctor
llm-coding-bridge doctor --tools
llm-coding-bridge status
```

启动服务：

```bash
llm-coding-bridge serve
```

Codex 的 `base_url` 配为：

```text
http://127.0.0.1:37629/v1
```

Codex CLI 建议用独立 profile，避免影响默认配置：

```bash
llm-coding-bridge codex-profile --name bridge
codex --profile bridge exec --skip-git-repo-check "Reply exactly: OK"
```

已有生成文件时使用 `--force` 覆盖；覆盖前会先备份。

输出中应看到：

```text
provider: llm-coding-bridge
```

如果仍是 `provider: openai`，说明 profile 没有加载。检查文件名是否为 `~/.codex/bridge.config.toml`。

Codex Desktop 使用前要保证 bridge 在后台运行。macOS 可安装 launchd 服务：

```bash
llm-coding-bridge install-service
curl http://127.0.0.1:37629/health
```

配置或包升级后重启服务：

```bash
llm-coding-bridge restart-service
```

然后备份 `~/.codex/config.toml`，把同一段 provider 配置和顶部的 `model` / `model_provider` 写入 `~/.codex/config.toml`，修改后重启桌面端。也可以在 `init` 中确认后自动写入。

输出 Codex Desktop 模板：

```bash
llm-coding-bridge template codex-desktop
```

需要把 bridge 配成 Codex Desktop 默认 provider 时使用这个模板。它也会影响没有使用 `--profile` 的 Codex CLI 会话。

Claude 类客户端配置：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:37629"
export ANTHROPIC_AUTH_TOKEN="local"
export ANTHROPIC_DEFAULT_SONNET_MODEL="your-model"
export ANTHROPIC_DEFAULT_OPUS_MODEL="your-model"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="your-model"
```

如果只想临时验证，不读取现有 `~/.claude/settings.json`：

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:37629" \
ANTHROPIC_AUTH_TOKEN="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

长期使用建议安装 macOS 自启动。API Key 可以由 bridge 通过环境变量/Keychain 命令读取，也可以由本地 provider switcher 管理并随请求传入。

查看最近日志：

```bash
llm-coding-bridge logs --lines 80
```

多上游路由：用 `upstreams` 数组替代 `upstream`，按客户端请求的 `model` 字段路由到不同上游。多上游时未知 model 返回 404，不静默回退；单上游时客户端 model 字段被改写为配置值（向后兼容）。详见上方 "Multiple upstreams"。

本地鉴权：配置 `server.localToken` 后，请求须带 `Authorization: Bearer <token>` 或 `x-api-key: <token>`。使用非 loopback 监听地址时该配置为必填项。

上游响应限制：`upstream.timeoutMs` 默认 10 分钟并覆盖完整响应正文；`upstream.maxResponseBytes` 默认 32 MiB；`upstream.maxSseEventBytes` 默认 1 MiB。三项都必须是正整数。

API Key 缓存：`apiKeyCommand` 结果默认缓存 10 分钟，用 `upstream.apiKeyCacheTtlMs` 覆盖，设 `0` 禁用。上游返回 401 时缓存立即失效，下次请求重新解析，轮换的 key 无需重启即可恢复。

如果希望由客户端路由工具管理上游 Key，把 `apiKeySource` 设为 `client`，并删除 `apiKeyEnv` / `apiKeyCommand`：

```json
{
  "upstream": {
    "name": "Custom Provider",
    "baseUrl": "https://api.example.com/v1",
    "model": "model-name",
    "apiKeySource": "client"
  }
}
```

bridge 会把客户端请求里的 key 转发给上游。读取顺序为：`x-upstream-api-key`、`Authorization: Bearer ...`、`x-api-key`。如果启用了 `server.localToken`，本地 token 放 `Authorization`，上游 key 放 `x-upstream-api-key`。

### ZCode 与上游兼容

部分 OpenAI-compatible 上游不接受客户端扩展字段，或在 `stream: false` 请求中仍使用 SSE 响应格式。bridge 为 ZCode 和其他 OpenAI-compatible 客户端提供这两类兼容处理。

上游不接受 `chat_template_kwargs` 时，启用请求字段清理：

```json
{
  "upstream": {
    "stripChatTemplateKwargs": true
  }
}
```

启用后，bridge 仅移除请求顶层的 `chat_template_kwargs` 和 `extra_body.chat_template_kwargs`，其余字段保持不变。该清理同时适用于流式和非流式请求。

对于 `stream: false` 请求，如果上游返回完整 SSE 序列，bridge 会将其聚合为标准 OpenAI `chat.completion` JSON 对象，以兼容 ZCode 的上下文压缩和摘要流程。响应归一化仅作用于非流式请求；流式响应正文仍原样透传。

#### 流式保活与睡眠唤醒恢复

OpenAI Chat Completions 的 `stream: true` 请求会立即提交 SSE 头；之后每次连续空闲达到 `server.heartbeatIntervalMs`（默认 `15000`；`0` 禁用）时，bridge 都会发送一个协议有效、`delta` 为空的 `chat.completion.chunk`。每收到一个真实上游数据块，空闲计时就重新开始，后续流中间再次长时间静默时仍会继续保活。因此 ZCode 在首字节前和长流中间都能看到模型数据事件。Responses 路径保留立即发送的 `response.created` / `response.in_progress` 事件及注释心跳；Anthropic 路径在等待完整上游响应时保留注释心跳。

MacBook 盒盖会挂起本地 bridge，并通常使已打开的 TCP 流失效；macOS 进入 clamshell sleep 后，本地进程本身无法继续执行。唤醒后，如果 Chat 上游发生传输错误，bridge 会把它作为下游连接失败暴露给 ZCode，使 ZCode 能执行自身的请求重试策略。bridge 不会阻止 macOS 睡眠，也不会自行重放已经部分消费的请求，以免造成重复模型计算或计费。上游明确返回 HTTP 错误、空正文或非 SSE 流式正文时，仍会按协议返回流内 SSE 错误和 `data: [DONE]`，因为这些属于上游协议响应，不是网络传输中断。

## Security

- Config files should not contain API keys.
- Use `apiKeyEnv` for interactive sessions.
- Use `apiKeyCommand` for background services. Prefer the object form `{ "command": "/usr/bin/security", "args": [...] }` over the string form; the string form runs through `/bin/sh -lc` and is only for convenience.
- Use `apiKeySource: "client"` when a local provider switcher owns the upstream key.
- API key command results are cached in-process (default 10 min, override with `apiKeyCacheTtlMs`; set `0` to disable). The cache is busted automatically on an upstream 401.
- Set `server.localToken` to require a bearer/x-api-key on every request. It is mandatory for non-loopback listeners.
- Request bodies are capped at 10 MB by default (`server.maxBodyBytes`).
- Upstream bodies have a complete-response deadline and cumulative size limit. Parsed SSE events have an independent size limit.
- CLI-generated secret-bearing files and backups use mode `0600`.
- Do not commit private config files.

### Why this package runs shell commands

This is a local bridge: it reads API keys from the environment or an OS keychain (`apiKeyCommand`), or forwards client-provided upstream keys when `apiKeySource` is `client`. It can install a macOS launchd service (`launchctl`) and write Codex/Claude profile files under your home directory. These require shell execution, environment-variable access, and filesystem writes — they are the package's purpose, not side effects. It has zero runtime dependencies and no install scripts.
