# Configuration Guide

This guide explains how to configure `@sevoniva/llm-coding-bridge` for a dedicated OpenAI-compatible upstream provider.

The bridge exposes local endpoints for coding clients:

- Codex CLI / Codex Desktop: `http://127.0.0.1:37629/v1/responses`
- Claude Code: `http://127.0.0.1:37629/v1/messages`
- OpenAI-compatible clients: `http://127.0.0.1:37629/v1/chat/completions`

The upstream provider must support OpenAI-compatible `/v1/chat/completions`.

## 1. Install

```bash
npm install -g @sevoniva/llm-coding-bridge
```

For a local tarball:

```bash
npm install -g ./sevoniva-llm-coding-bridge-*.tgz
```

Confirm the command is available:

```bash
llm-coding-bridge --help
```

## 2. Guided Setup

Run the setup guide:

```bash
llm-coding-bridge init
```

The config is written to `~/.llm-coding-bridge/config.json` by default (override with `--out`). All commands read that file by default; a `llm-coding-bridge.config.json` in the current directory takes precedence, and `--config` overrides both.

### Upgrading to v0.5.0

Version `0.5.0` changes the default local port from `18080` to `37629`. The port is configurable and is not reserved exclusively for this project.

Installing a new package version does not rewrite `~/.llm-coding-bridge/config.json` or client settings. Existing installations can continue using an explicitly configured port. To adopt the new default:

1. Change `server.port` to `37629` in the bridge config.
2. Change the port in every Codex, Claude, ZCode, or other client Base URL.
3. Restart the service with `llm-coding-bridge restart-service`.
4. Confirm that `http://127.0.0.1:37629/health` returns `{"ok":true}`.

The command starts an interactive bilingual setup flow:

```text
LLM Coding Bridge setup / LLM Coding Bridge 配置向导
API keys are not written to config files. Use local for env/command, or client for provider switchers.
配置文件不写入 API Key。local 表示从环境变量/命令读取，client 表示由客户端或切换工具传入。

Listen host / 本地监听地址 [127.0.0.1]: 127.0.0.1
Listen port / 本地监听端口 [37629]: 37629
Provider name / 上游服务名称 [Custom Provider]: Custom Provider
Upstream base URL / 上游 Base URL: https://api.example.com/v1
Upstream model / 上游模型名称: model-name
API key source (local/client) / API Key 来源（local/client）[local]: local
API key environment variable / API Key 环境变量 [LLM_API_KEY]: LLM_API_KEY
API key command (optional) / API Key 读取命令（可选）:
Temperature / 采样温度 [0]: 0
Local auth token (optional, blank to disable) / 本地鉴权 token（可选，留空不启用）:
Configure local clients now? / 是否现在配置本地客户端？[y/N]:

Wrote config: /Users/me/.llm-coding-bridge/config.json
配置已写入：/Users/me/.llm-coding-bridge/config.json
```

Client setup defaults to `No`. When enabled, `init` can merge Claude Code settings, generate an isolated Codex CLI profile, or configure Codex Desktop after a separate confirmation. Existing files are backed up first with `.bak-YYYYMMDD-HHMMSS`.

Prompt reference:

| Prompt | Description | Recommended value |
|---|---|---|
| `Listen host` | Local bind address. Use loopback for local-only access. | `127.0.0.1` |
| `Listen port` | Local bridge port used by Codex and Claude Code. | `37629` |
| `Provider name` | Display name for logs and doctor output. | Provider or team name |
| `Upstream base URL` | OpenAI-compatible upstream base URL. Include `/v1`. | `https://api.example.com/v1` |
| `Upstream model` | Model name sent to the upstream provider. | Provider model ID |
| `API key source` | `local` lets the bridge read the upstream key from env/command. `client` forwards the key sent by the client or provider switcher. | `local`, or `client` with a provider switcher |
| `API key environment variable` | Shown when source is `local`. Environment variable used to read the upstream API key. | `LLM_API_KEY` |
| `API key command` | Shown when source is `local`. Optional command that prints the upstream API key. Recommended for background services. | Keychain or secret-manager command |
| `Temperature` | Sampling temperature sent to the upstream provider. | `0` for coding workflows |
| `Local auth token` | Optional bearer/x-api-key token clients must present. Leave blank to disable. Strongly recommended when binding to a non-loopback address. | Random secret, or blank |
| `Configure local clients now?` | Optional client setup for Claude Code, Codex CLI, and Codex Desktop. Defaults to no writes. | `N`, then configure clients only when ready |

Generated config:

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
    "temperature": 0,
    "reasoningEffort": "none"
  }
}
```

Do not store API keys in this file.

When `API key source` is `client`, the generated upstream uses `apiKeySource` and does not include `apiKeyEnv` or `apiKeyCommand`:

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

Optional vision metadata:

```json
{
  "upstream": {
    "inputModalities": ["text", "image"]
  }
}
```

Keep the default `["text"]` unless the upstream model can process image input.

## 3. API Key Options

### Environment Variable

Use this for terminal sessions:

```bash
export LLM_API_KEY="..."
llm-coding-bridge doctor
```

Config:

```json
{
  "upstream": {
    "apiKeyEnv": "LLM_API_KEY"
  }
}
```

### Command-Backed Key

Use this for background services. It avoids relying on shell startup files.

macOS Keychain example:

```json
{
  "upstream": {
    "apiKeyCommand": {
      "command": "/usr/bin/security",
      "args": [
        "find-generic-password",
        "-a",
        "LLM_API_KEY",
        "-s",
        "llm-coding-bridge",
        "-w"
      ]
    }
  }
}
```

Store the key:

```bash
security add-generic-password \
  -a LLM_API_KEY \
  -s llm-coding-bridge \
  -w "YOUR_API_KEY" \
  -U
```

The `apiKeyCommand` accepts either an object (`{ "command", "args" }`, run directly without a shell) or a string (run through `/bin/sh -lc`). Prefer the object form — it avoids shell interpretation and is the form `init` writes when given a keychain command. Results are cached in-process for 10 minutes by default; override with `upstream.apiKeyCacheTtlMs`, or set it to `0` to resolve the key on every request. If the upstream returns `401`, the cached key is dropped immediately so the next request re-resolves — a rotated key recovers without restarting the bridge.

### Client-Provided Key

Use this when a local provider switcher owns the real upstream key. The bridge config does not store or read an upstream key:

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

The bridge forwards the client request key as the upstream bearer token. It reads headers in this order:

```text
x-upstream-api-key
Authorization: Bearer <key>
x-api-key
```

For provider switchers that send `Authorization: Bearer <key>`, no extra bridge setting is needed. If `server.localToken` is also enabled, use `Authorization` for the local token and `x-upstream-api-key` for the upstream key.

For generated Codex or Claude configs in this mode, set the client token to the real upstream key, or let the provider switcher manage the client config. To run `doctor`, provide a probe key:

```bash
LLM_CODING_BRIDGE_CLIENT_API_KEY="..." llm-coding-bridge doctor
```

## 3a. Local Auth

By default the bridge listens on `127.0.0.1` and does not require auth. To require a token, set `server.localToken`:

```json
{
  "server": { "host": "127.0.0.1", "port": 37629, "localToken": "your-secret" }
}
```

Clients must then send `Authorization: Bearer your-secret` or `x-api-key: your-secret`. `/health` remains unauthenticated. Comparison is constant-time. When `localToken` is set, update the Codex profile's `experimental_bearer_token` and Claude's `ANTHROPIC_AUTH_TOKEN` to the same value. Strongly recommended when binding to a non-loopback address.

## 3b. Multiple Upstreams

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

A request with `model: "gpt-4o"` routes to OpenAI; `model: "other-model"` routes to Other. With multiple upstreams, a model matching none of them returns `404 model_not_found` rather than silently routing to the wrong provider. With a single `upstream`, the client's model field is rewritten to the configured one (backward compatible). `/v1/models` lists all configured models. Each upstream has an independent API-key cache.

## 3c. Request Limits

Request bodies are capped at 10 MB by default. Override with `server.maxBodyBytes` (bytes). Oversized requests receive `413 payload_too_large` and the connection is closed.

```json
{
  "server": { "host": "127.0.0.1", "port": 37629, "maxBodyBytes": 20971520 }
}
```

## 3d. ZCode and Provider Compatibility

Some OpenAI-compatible endpoints reject client extension fields or return an SSE sequence for a non-streaming request. The bridge handles both cases so ZCode and similar clients can use normal turns, summarization, and context compaction reliably.

Enable request cleanup when the upstream does not accept `chat_template_kwargs`:

```json
{
  "upstream": {
    "stripChatTemplateKwargs": true
  }
}
```

When enabled, the bridge removes only these fields before forwarding the request:

- `chat_template_kwargs`
- `extra_body.chat_template_kwargs`

Other top-level fields and other `extra_body` fields are preserved.

For `stream: false` requests, the bridge expects one JSON response. If the upstream returns a complete SSE sequence instead, the bridge aggregates the chunks into a standard OpenAI `chat.completion` object. Response normalization is automatic and limited to non-streaming requests. Streaming response bodies pass through unchanged, while request cleanup applies to both modes when enabled.

## 4. Validate

Check the upstream and conversion path:

```bash
llm-coding-bridge doctor
```

Expected result:

```text
[OK] Custom Provider -> model-name
```

Start the bridge:

```bash
llm-coding-bridge serve
```

Health check:

```bash
curl http://127.0.0.1:37629/health
```

Expected result:

```json
{"ok":true}
```

Local service check without an upstream model call:

```bash
llm-coding-bridge status
```

Full endpoint check:

```bash
llm-coding-bridge doctor --deep
```

Tool-call check:

```bash
llm-coding-bridge doctor --tools
```

This verifies function, freeform, and tool-search conversion through the local bridge.

## 5. Configure Codex

Print the template:

```bash
llm-coding-bridge template codex
```

User-level Codex config example:

```toml
model = "model-name"
model_provider = "llm-coding-bridge"
model_reasoning_effort = "none"
disable_response_storage = true
# `llm-coding-bridge codex-profile` generates model_catalog_json automatically.

[model_providers.llm-coding-bridge]
name = "LLM Coding Bridge"
base_url = "http://127.0.0.1:37629/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

Use `local` for local key mode. In client key mode, use the upstream key here or let a provider switcher manage this client config.

Use a separate Codex CLI profile if you do not want to change the default provider:

```toml
# ~/.codex/bridge.config.toml
model = "model-name"
model_provider = "llm-coding-bridge"
model_reasoning_effort = "none"
disable_response_storage = true
model_catalog_json = "/absolute/path/to/codex-model-catalog.json"

[model_providers.llm-coding-bridge]
name = "LLM Coding Bridge"
base_url = "http://127.0.0.1:37629/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

Generate the profile from the bridge config:

```bash
llm-coding-bridge codex-profile --name bridge
```

The command writes `~/.codex/bridge.config.toml` and a local Codex model catalog. Use `--force` to overwrite generated files.
When generated files already exist and are overwritten, the command creates `.bak-YYYYMMDD-HHMMSS` backups first.

Run Codex CLI with the profile:

```bash
codex --profile bridge
```

Non-interactive check:

```bash
codex --profile bridge exec --skip-git-repo-check "Reply exactly: OK"
```

The startup summary should show:

```text
provider: llm-coding-bridge
```

If it shows `provider: openai`, Codex did not load the profile. Confirm the file is named exactly `~/.codex/bridge.config.toml`.

### Codex Desktop

Codex Desktop uses the default user-level config. To make Codex Desktop use the bridge, add the provider block and the top-level model settings to `~/.codex/config.toml`.

Keep the bridge running before opening Codex Desktop. On macOS, install the launchd service:

```bash
llm-coding-bridge install-service
curl http://127.0.0.1:37629/health
```

Back up the file first:

```bash
cp ~/.codex/config.toml ~/.codex/config.toml.bak.$(date +%Y%m%d%H%M%S)
```

Print the Desktop template:

```bash
llm-coding-bridge template codex-desktop
```

Add or update these values in `~/.codex/config.toml`:

```toml
model = "model-name"
model_provider = "llm-coding-bridge"
model_reasoning_effort = "none"
disable_response_storage = true
# For Desktop, set model_catalog_json to the generated catalog path if Codex reports custom model metadata warnings.

[model_providers.llm-coding-bridge]
name = "LLM Coding Bridge"
base_url = "http://127.0.0.1:37629/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

Restart Codex Desktop after the change. This makes the bridge the default provider for Codex Desktop and for Codex CLI sessions that do not pass `--profile`.

The `init` guide can write this Desktop config after a separate confirmation. Existing `~/.codex/config.toml` is backed up first.

## 6. Configure Claude Code

Print the template:

```bash
llm-coding-bridge template claude
```

Temporary session:

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:37629" \
ANTHROPIC_AUTH_TOKEN="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

Notes:

- `ANTHROPIC_BASE_URL` should not include `/v1`.
- `--setting-sources local` prevents existing user settings from overriding the test.
- In `local` key mode, `ANTHROPIC_AUTH_TOKEN` is a local compatibility token. In `client` key mode, set it to the upstream key or let a provider switcher manage it.

For persistent Claude Code use, add these environment variables to your shell profile or Claude settings:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:37629"
export ANTHROPIC_AUTH_TOKEN="local"
export ANTHROPIC_DEFAULT_SONNET_MODEL="model-name"
export ANTHROPIC_DEFAULT_OPUS_MODEL="model-name"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="model-name"
```

Or let `init` merge them into `~/.claude/settings.json`. Existing settings are backed up first:

```text
~/.claude/settings.json.bak-YYYYMMDD-HHMMSS
```

## 7. macOS Autostart

Install launchd service:

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

Logs:

```text
~/.llm-coding-bridge/logs/out.log
~/.llm-coding-bridge/logs/err.log
```

Print recent logs:

```bash
llm-coding-bridge logs --lines 80
```

Use `apiKeyCommand` for autostart. Environment variables from an interactive shell are not guaranteed to be available to launchd services.

## 8. Move to Another Computer

Install the package:

```bash
npm install -g @sevoniva/llm-coding-bridge
```

Copy or recreate:

```text
~/.llm-coding-bridge/config.json
Codex profile or provider config
Claude environment variables or settings
API key in the target machine's secure store
```

Then run:

```bash
llm-coding-bridge doctor
llm-coding-bridge install-service
llm-coding-bridge codex-profile --name bridge
llm-coding-bridge status
```

## 9. Troubleshooting

### `Missing API key env`

The configured environment variable is not set.

Fix:

```bash
export LLM_API_KEY="..."
```

For services, use `apiKeyCommand`.

### `Upstream HTTP 401`

The upstream rejected the key.

Check:

- the API key value
- the key source command
- whether the upstream expects a Bearer token

### Codex Returns No Text

Check that Codex uses Responses API:

```toml
wire_api = "responses"
```

Then run:

```bash
llm-coding-bridge doctor
```

### Claude Does Not Hit the Bridge

Use an isolated check:

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:37629" \
ANTHROPIC_AUTH_TOKEN="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

If this works, an existing Claude settings file is overriding the environment.

### Port Is Already in Use

Change the local port:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 37630
  }
}
```

Update Codex and Claude client configuration to use the same port.

---

# 配置指南

本文说明如何把一个 OpenAI-compatible `/v1/chat/completions` 上游服务接入 Codex 和 Claude 类客户端。

本地 bridge 暴露以下接口：

- Codex CLI / Codex Desktop：`http://127.0.0.1:37629/v1/responses`
- Claude Code：`http://127.0.0.1:37629/v1/messages`
- OpenAI-compatible 客户端：`http://127.0.0.1:37629/v1/chat/completions`

它面向专用上游连接：用一个本地端点同时服务 Codex、Claude Code 和 OpenAI-compatible 客户端。

## 1. 安装

```bash
npm install -g @sevoniva/llm-coding-bridge
```

本地 tarball 安装：

```bash
npm install -g ./sevoniva-llm-coding-bridge-*.tgz
```

确认命令可用：

```bash
llm-coding-bridge --help
```

## 2. 配置向导

运行配置向导：

```bash
llm-coding-bridge init
```

配置默认写入 `~/.llm-coding-bridge/config.json`（可用 `--out` 覆盖）。所有命令默认读取该文件；当前目录存在 `llm-coding-bridge.config.json` 时优先使用，`--config` 优先级最高。

### 升级到 v0.5.0

`0.5.0` 将默认本地端口从 `18080` 改为 `37629`。该端口可以继续自定义，项目不声明独占此端口。

安装新版本不会改写 `~/.llm-coding-bridge/config.json` 或客户端设置。已有安装可以继续使用显式配置的端口。迁移到新默认值时：

1. 在 bridge 配置中把 `server.port` 改为 `37629`。
2. 同步修改 Codex、Claude、ZCode 及其他客户端 Base URL 中的端口。
3. 执行 `llm-coding-bridge restart-service` 重启服务。
4. 确认 `http://127.0.0.1:37629/health` 返回 `{"ok":true}`。

命令会启动中英文交互式配置流程：

```text
LLM Coding Bridge setup / LLM Coding Bridge 配置向导
API keys are not written to config files. Use local for env/command, or client for provider switchers.
配置文件不写入 API Key。local 表示从环境变量/命令读取，client 表示由客户端或切换工具传入。

Listen host / 本地监听地址 [127.0.0.1]: 127.0.0.1
Listen port / 本地监听端口 [37629]: 37629
Provider name / 上游服务名称 [Custom Provider]: Custom Provider
Upstream base URL / 上游 Base URL: https://api.example.com/v1
Upstream model / 上游模型名称: model-name
API key source (local/client) / API Key 来源（local/client）[local]: local
API key environment variable / API Key 环境变量 [LLM_API_KEY]: LLM_API_KEY
API key command (optional) / API Key 读取命令（可选）:
Temperature / 采样温度 [0]: 0
Local auth token (optional, blank to disable) / 本地鉴权 token（可选，留空不启用）:
Configure local clients now? / 是否现在配置本地客户端？[y/N]:

Wrote config: /Users/me/.llm-coding-bridge/config.json
配置已写入：/Users/me/.llm-coding-bridge/config.json
```

客户端配置默认不写入。确认后，`init` 可以合并 Claude Code 配置、生成 Codex CLI 独立 profile，或在单独确认后配置 Codex Desktop。已有文件会先创建 `.bak-YYYYMMDD-HHMMSS` 备份。

字段说明：

| 提示项 | 说明 | 建议值 |
|---|---|---|
| `Listen host` | 本地监听地址。仅本机使用时保持 loopback 地址。 | `127.0.0.1` |
| `Listen port` | 本地 bridge 端口，Codex 和 Claude Code 都连接这个端口。 | `37629` |
| `Provider name` | 用于日志和 doctor 输出的显示名称。 | 服务名称或团队名称 |
| `Upstream base URL` | OpenAI-compatible 上游 Base URL，需要包含 `/v1`。 | `https://api.example.com/v1` |
| `Upstream model` | 发送给上游服务的模型名称。 | 上游模型 ID |
| `API key source` | `local` 表示 bridge 从环境变量/命令读取上游 Key；`client` 表示转发客户端或 provider switcher 传入的 Key。 | 默认 `local`；使用切换工具时选 `client` |
| `API key environment variable` | source 为 `local` 时出现。读取上游 API Key 的环境变量名。 | `LLM_API_KEY` |
| `API key command` | source 为 `local` 时出现。可选，输出上游 API Key 的命令，适合后台服务和开机自启。 | Keychain 或密钥管理命令 |
| `Temperature` | 发送给上游服务的采样温度。 | 编码场景建议 `0` |
| `Local auth token` | 可选。客户端必须携带的 bearer/x-api-key token，留空则不启用。绑非 loopback 时强烈建议配置。 | 随机密钥，或留空 |
| `Configure local clients now?` | 可选配置 Claude Code、Codex CLI 和 Codex Desktop。默认不写文件。 | `N`，需要时再确认配置 |

生成配置示例：

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
    "temperature": 0,
    "reasoningEffort": "none"
  }
}
```

配置文件不保存 API Key。

当 `API key source` 选择 `client` 时，生成的上游配置使用 `apiKeySource`，不会包含 `apiKeyEnv` 或 `apiKeyCommand`：

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

可选视觉能力声明：

```json
{
  "upstream": {
    "inputModalities": ["text", "image"]
  }
}
```

除非上游模型确认支持图片输入，否则保持默认 `["text"]`。

## 3. API Key 配置

### 环境变量

适合手动启动服务：

```bash
export LLM_API_KEY="..."
llm-coding-bridge doctor
```

配置字段：

```json
{
  "upstream": {
    "apiKeyEnv": "LLM_API_KEY"
  }
}
```

### 命令读取

适合后台服务和开机自启：

```json
{
  "upstream": {
    "apiKeyCommand": {
      "command": "/usr/bin/security",
      "args": [
        "find-generic-password",
        "-a",
        "LLM_API_KEY",
        "-s",
        "llm-coding-bridge",
        "-w"
      ]
    }
  }
}
```

写入 macOS Keychain：

```bash
security add-generic-password \
  -a LLM_API_KEY \
  -s llm-coding-bridge \
  -w "YOUR_API_KEY" \
  -U
```

`apiKeyCommand` 接受对象（`{ "command", "args" }`，直接执行不走 shell）或字符串（走 `/bin/sh -lc`）两种形式。推荐对象形式——避免 shell 解释，`init` 写入 keychain 命令时也用这种。结果默认缓存 10 分钟，用 `upstream.apiKeyCacheTtlMs` 覆盖，设 `0` 每次请求重新解析。上游返回 401 时缓存立即失效，下次请求重新解析，轮换的 key 无需重启即可恢复。

### 客户端传入 Key

适合由本地 provider switcher 管理真实上游 Key 的场景。bridge 配置里不保存也不读取上游 Key：

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

bridge 会把客户端请求里的 key 作为上游 bearer token 转发。读取顺序：

```text
x-upstream-api-key
Authorization: Bearer <key>
x-api-key
```

如果 provider switcher 发送 `Authorization: Bearer <key>`，bridge 不需要额外配置。如果同时启用 `server.localToken`，`Authorization` 放本地 token，上游 key 放 `x-upstream-api-key`。

此模式下生成 Codex 或 Claude 配置时，客户端 token 要填真实上游 Key；也可以交给 provider switcher 管理客户端配置。运行 `doctor` 时提供检测用 Key：

```bash
LLM_CODING_BRIDGE_CLIENT_API_KEY="..." llm-coding-bridge doctor
```

## 3a. 本地鉴权

默认监听 `127.0.0.1` 且不要求鉴权。需要 token 时配置 `server.localToken`：

```json
{
  "server": { "host": "127.0.0.1", "port": 37629, "localToken": "your-secret" }
}
```

客户端须带 `Authorization: Bearer your-secret` 或 `x-api-key: your-secret`。`/health` 不鉴权。比较为常量时间。配置 localToken 后，Codex profile 的 `experimental_bearer_token` 和 Claude 的 `ANTHROPIC_AUTH_TOKEN` 要改成同一个值。绑非 loopback 时强烈建议启用。

## 3b. 多上游

按客户端请求的 `model` 字段路由到不同上游。用 `upstreams` 替代 `upstream`：

```json
{
  "server": { "host": "127.0.0.1", "port": 37629 },
  "upstreams": [
    { "name": "OpenAI", "model": "gpt-4o", "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" },
    { "name": "Other", "model": "other-model", "baseUrl": "https://api.other.com/v1", "apiKeyEnv": "OTHER_API_KEY" }
  ]
}
```

`model: "gpt-4o"` 路由到 OpenAI，`model: "other-model"` 路由到 Other。多上游时未知 model 返回 `404 model_not_found`，不静默回退；单 `upstream` 时客户端 model 字段被改写为配置值（向后兼容）。`/v1/models` 列出全部已配置模型。每个上游有独立的 API Key 缓存。

## 3c. 请求体限制

请求体默认上限 10 MB，用 `server.maxBodyBytes`（字节）覆盖。超限返回 `413 payload_too_large` 并关闭连接。

```json
{
  "server": { "host": "127.0.0.1", "port": 37629, "maxBodyBytes": 20971520 }
}
```

## 3d. ZCode 与上游兼容

部分 OpenAI-compatible 上游不接受客户端扩展字段，或在非流式请求中返回 SSE 序列。bridge 对这两类差异进行兼容处理，使 ZCode 和同类客户端能够稳定执行普通请求、摘要和上下文压缩。

上游不接受 `chat_template_kwargs` 时，启用请求字段清理：

```json
{
  "upstream": {
    "stripChatTemplateKwargs": true
  }
}
```

启用后，bridge 仅移除以下字段：

- `chat_template_kwargs`
- `extra_body.chat_template_kwargs`

其余顶层字段和 `extra_body` 字段保持不变。该清理同时适用于流式和非流式请求。

对于 `stream: false` 请求，如果上游返回完整 SSE 序列，bridge 会将其聚合为标准 OpenAI `chat.completion` 对象。响应归一化仅作用于非流式请求；流式响应正文仍原样透传。

## 4. 检测和启动

检测上游和协议转换：

```bash
llm-coding-bridge doctor
```

期望输出：

```text
[OK] Custom Provider -> model-name
```

启动服务：

```bash
llm-coding-bridge serve
```

健康检查：

```bash
curl http://127.0.0.1:37629/health
```

期望输出：

```json
{"ok":true}
```

不调用上游模型的本地服务检测：

```bash
llm-coding-bridge status
```

完整端点检测：

```bash
llm-coding-bridge doctor --deep
```

工具调用检测：

```bash
llm-coding-bridge doctor --tools
```

该命令会验证 function、freeform 和 tool-search 的本地转换链路。

## 5. 配置 Codex

输出模板：

```bash
llm-coding-bridge template codex
```

Codex 用户级配置示例：

```toml
model = "model-name"
model_provider = "llm-coding-bridge"
model_reasoning_effort = "none"
disable_response_storage = true
# `llm-coding-bridge codex-profile` 会自动生成 model_catalog_json。

[model_providers.llm-coding-bridge]
name = "LLM Coding Bridge"
base_url = "http://127.0.0.1:37629/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

`local` 适用于 local key 模式。client key 模式下，这里填上游 Key，或交给 provider switcher 管理客户端配置。

如果不想影响默认 Codex 配置，Codex CLI 建议使用独立 profile：

```toml
# ~/.codex/bridge.config.toml
model = "model-name"
model_provider = "llm-coding-bridge"
model_reasoning_effort = "none"
disable_response_storage = true
model_catalog_json = "/absolute/path/to/codex-model-catalog.json"

[model_providers.llm-coding-bridge]
name = "LLM Coding Bridge"
base_url = "http://127.0.0.1:37629/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

从 bridge 配置生成 profile：

```bash
llm-coding-bridge codex-profile --name bridge
```

命令会写入 `~/.codex/bridge.config.toml` 和本地 Codex model catalog。已有生成文件时使用 `--force` 覆盖；覆盖前会创建 `.bak-YYYYMMDD-HHMMSS` 备份。

使用 profile 启动：

```bash
codex --profile bridge
```

非交互检测：

```bash
codex --profile bridge exec --skip-git-repo-check "Reply exactly: OK"
```

启动摘要中应看到：

```text
provider: llm-coding-bridge
```

如果看到 `provider: openai`，说明 Codex 没有加载 profile。检查文件名是否为 `~/.codex/bridge.config.toml`。

### Codex Desktop

Codex Desktop 使用默认用户级配置。要让 Codex Desktop 使用 bridge，需要把 provider 配置和顶部模型设置写入 `~/.codex/config.toml`。

打开 Codex Desktop 前，先保证 bridge 在后台运行。macOS 可安装 launchd 服务：

```bash
llm-coding-bridge install-service
curl http://127.0.0.1:37629/health
```

先备份配置：

```bash
cp ~/.codex/config.toml ~/.codex/config.toml.bak.$(date +%Y%m%d%H%M%S)
```

输出 Desktop 模板：

```bash
llm-coding-bridge template codex-desktop
```

把这些配置添加或更新到 `~/.codex/config.toml`：

```toml
model = "model-name"
model_provider = "llm-coding-bridge"
model_reasoning_effort = "none"
disable_response_storage = true
# 如果 Codex Desktop 提示自定义模型元数据缺失，把 model_catalog_json 设置为生成的 catalog 路径。

[model_providers.llm-coding-bridge]
name = "LLM Coding Bridge"
base_url = "http://127.0.0.1:37629/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

修改后重启 Codex Desktop。这样会把 bridge 作为 Codex Desktop 默认 provider，也会影响没有使用 `--profile` 的 Codex CLI 会话。

`init` 向导也可以在单独确认后写入 Desktop 配置。已有 `~/.codex/config.toml` 会先备份。

## 6. 配置 Claude Code

输出模板：

```bash
llm-coding-bridge template claude
```

临时验证：

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:37629" \
ANTHROPIC_AUTH_TOKEN="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

注意：

- `ANTHROPIC_BASE_URL` 不带 `/v1`。
- `--setting-sources local` 用于避免现有用户配置覆盖本次验证。
- `local` key 模式下，`ANTHROPIC_AUTH_TOKEN` 是本地兼容 token。`client` key 模式下，它应是真实上游 Key，或交给 provider switcher 管理。

长期使用可把环境变量写入 shell profile 或 Claude 配置：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:37629"
export ANTHROPIC_AUTH_TOKEN="local"
export ANTHROPIC_DEFAULT_SONNET_MODEL="model-name"
export ANTHROPIC_DEFAULT_OPUS_MODEL="model-name"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="model-name"
```

也可以让 `init` 合并写入 `~/.claude/settings.json`。已有配置会先备份：

```text
~/.claude/settings.json.bak-YYYYMMDD-HHMMSS
```

## 7. macOS 开机自启

安装 launchd 服务：

```bash
llm-coding-bridge install-service
```

配置或包升级后重启服务：

```bash
llm-coding-bridge restart-service
```

卸载：

```bash
llm-coding-bridge uninstall-service
```

日志位置：

```text
~/.llm-coding-bridge/logs/out.log
~/.llm-coding-bridge/logs/err.log
```

查看最近日志：

```bash
llm-coding-bridge logs --lines 80
```

开机自启建议使用 `apiKeyCommand`，不要依赖交互式终端的环境变量。

## 8. 换电脑

新机器需要准备：

```text
Node.js
@sevoniva/llm-coding-bridge
~/.llm-coding-bridge/config.json
Codex provider/profile 配置
Claude 环境变量或配置
目标机器安全存储中的 API Key
```

验证：

```bash
llm-coding-bridge doctor
llm-coding-bridge install-service
llm-coding-bridge codex-profile --name bridge
llm-coding-bridge status
```

## 9. 常见问题

### `Missing API key env`

配置的环境变量不存在。

修复：

```bash
export LLM_API_KEY="..."
```

后台服务建议改用 `apiKeyCommand`。

### `Upstream HTTP 401`

上游拒绝认证。

检查：

- API Key 是否正确
- `apiKeyCommand` 是否能返回 key
- 上游是否使用 Bearer Token

### Codex 没有输出

确认 Codex 使用 Responses API：

```toml
wire_api = "responses"
```

再运行：

```bash
llm-coding-bridge doctor
```

### Claude 没有请求本地服务

先用隔离命令验证：

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:37629" \
ANTHROPIC_AUTH_TOKEN="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

如果隔离命令可用，通常是已有 Claude 用户配置覆盖了环境变量。

### 端口被占用

修改本地端口：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 37630
  }
}
```

同时更新 Codex 和 Claude 客户端配置。
