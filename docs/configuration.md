# Configuration Guide

This guide explains how to configure `@sevoniva/llm-coding-bridge` for a dedicated OpenAI-compatible upstream provider.

The bridge exposes local endpoints for coding clients:

- Codex CLI / Codex Desktop: `http://127.0.0.1:18080/v1/responses`
- Claude Code: `http://127.0.0.1:18080/v1/messages`
- OpenAI-compatible clients: `http://127.0.0.1:18080/v1/chat/completions`

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
llm-coding-bridge init --out ~/.llm-coding-bridge/config.json
```

The command starts an interactive bilingual setup flow:

```text
LLM Coding Bridge setup / LLM Coding Bridge 配置向导
API keys are read from environment variables or commands and are not written to config files.
API Key 通过环境变量或命令读取，不写入配置文件。

Listen host / 本地监听地址 [127.0.0.1]: 127.0.0.1
Listen port / 本地监听端口 [18080]: 18080
Provider name / 上游服务名称 [Custom Provider]: Custom Provider
Upstream base URL / 上游 Base URL: https://api.example.com/v1
Upstream model / 上游模型名称: model-name
API key environment variable / API Key 环境变量 [LLM_API_KEY]: LLM_API_KEY
API key command (optional) / API Key 读取命令（可选）:
Temperature / 采样温度 [0]: 0

Wrote config: /Users/me/.llm-coding-bridge/config.json
配置已写入：/Users/me/.llm-coding-bridge/config.json
Set key: export LLM_API_KEY="..."
设置 Key：export LLM_API_KEY="..."
```

Prompt reference:

| Prompt | Description | Recommended value |
|---|---|---|
| `Listen host` | Local bind address. Use loopback for local-only access. | `127.0.0.1` |
| `Listen port` | Local bridge port used by Codex and Claude Code. | `18080` |
| `Provider name` | Display name for logs and doctor output. | Provider or team name |
| `Upstream base URL` | OpenAI-compatible upstream base URL. Include `/v1`. | `https://api.example.com/v1` |
| `Upstream model` | Model name sent to the upstream provider. | Provider model ID |
| `API key environment variable` | Environment variable used to read the upstream API key. | `LLM_API_KEY` |
| `API key command` | Optional command that prints the upstream API key. Recommended for background services. | Keychain or secret-manager command |
| `Temperature` | Sampling temperature sent to the upstream provider. | `0` for coding workflows |

Generated config:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 18080
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
llm-coding-bridge doctor --config ~/.llm-coding-bridge/config.json
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

## 4. Validate

Check the upstream and conversion path:

```bash
llm-coding-bridge doctor --config ~/.llm-coding-bridge/config.json
```

Expected result:

```text
[OK] Custom Provider -> model-name
```

Start the bridge:

```bash
llm-coding-bridge serve --config ~/.llm-coding-bridge/config.json
```

Health check:

```bash
curl http://127.0.0.1:18080/health
```

Expected result:

```json
{"ok":true}
```

Local service check without an upstream model call:

```bash
llm-coding-bridge status --config ~/.llm-coding-bridge/config.json
```

Full endpoint check:

```bash
llm-coding-bridge doctor --deep --config ~/.llm-coding-bridge/config.json
```

Tool-call check:

```bash
llm-coding-bridge doctor --tools --config ~/.llm-coding-bridge/config.json
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
base_url = "http://127.0.0.1:18080/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

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
base_url = "http://127.0.0.1:18080/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

Generate the profile from the bridge config:

```bash
llm-coding-bridge codex-profile --config ~/.llm-coding-bridge/config.json --name bridge
```

The command writes `~/.codex/bridge.config.toml` and a local Codex model catalog. Use `--force` to overwrite generated files.

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
llm-coding-bridge install-service --config ~/.llm-coding-bridge/config.json
curl http://127.0.0.1:18080/health
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
base_url = "http://127.0.0.1:18080/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

Restart Codex Desktop after the change. This makes the bridge the default provider for Codex Desktop and for Codex CLI sessions that do not pass `--profile`.

## 6. Configure Claude Code

Print the template:

```bash
llm-coding-bridge template claude
```

Temporary session:

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:18080" \
ANTHROPIC_API_KEY="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

Notes:

- `ANTHROPIC_BASE_URL` should not include `/v1`.
- `--setting-sources local` prevents existing user settings from overriding the test.
- `ANTHROPIC_API_KEY` is only used by the local bridge for client compatibility; upstream authentication is configured in `~/.llm-coding-bridge/config.json`.

For persistent Claude Code use, add these environment variables to your shell profile or Claude settings:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:18080"
export ANTHROPIC_API_KEY="local"
```

## 7. macOS Autostart

Install launchd service:

```bash
llm-coding-bridge install-service --config ~/.llm-coding-bridge/config.json
```

Restart it after package or config changes:

```bash
llm-coding-bridge restart-service --config ~/.llm-coding-bridge/config.json
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
llm-coding-bridge doctor --config ~/.llm-coding-bridge/config.json
llm-coding-bridge install-service --config ~/.llm-coding-bridge/config.json
llm-coding-bridge codex-profile --config ~/.llm-coding-bridge/config.json --name bridge
llm-coding-bridge status --config ~/.llm-coding-bridge/config.json
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
llm-coding-bridge doctor --config ~/.llm-coding-bridge/config.json
```

### Claude Does Not Hit the Bridge

Use an isolated check:

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:18080" \
ANTHROPIC_API_KEY="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

If this works, an existing Claude settings file is overriding the environment.

### Port Is Already in Use

Change the local port:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 18081
  }
}
```

Update Codex and Claude client configuration to use the same port.

---

# 配置指南

本文说明如何把一个 OpenAI-compatible `/v1/chat/completions` 上游服务接入 Codex 和 Claude 类客户端。

本地 bridge 暴露以下接口：

- Codex CLI / Codex Desktop：`http://127.0.0.1:18080/v1/responses`
- Claude Code：`http://127.0.0.1:18080/v1/messages`
- OpenAI-compatible 客户端：`http://127.0.0.1:18080/v1/chat/completions`

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
llm-coding-bridge init --out ~/.llm-coding-bridge/config.json
```

命令会启动中英文交互式配置流程：

```text
LLM Coding Bridge setup / LLM Coding Bridge 配置向导
API keys are read from environment variables or commands and are not written to config files.
API Key 通过环境变量或命令读取，不写入配置文件。

Listen host / 本地监听地址 [127.0.0.1]: 127.0.0.1
Listen port / 本地监听端口 [18080]: 18080
Provider name / 上游服务名称 [Custom Provider]: Custom Provider
Upstream base URL / 上游 Base URL: https://api.example.com/v1
Upstream model / 上游模型名称: model-name
API key environment variable / API Key 环境变量 [LLM_API_KEY]: LLM_API_KEY
API key command (optional) / API Key 读取命令（可选）:
Temperature / 采样温度 [0]: 0

Wrote config: /Users/me/.llm-coding-bridge/config.json
配置已写入：/Users/me/.llm-coding-bridge/config.json
Set key: export LLM_API_KEY="..."
设置 Key：export LLM_API_KEY="..."
```

字段说明：

| 提示项 | 说明 | 建议值 |
|---|---|---|
| `Listen host` | 本地监听地址。仅本机使用时保持 loopback 地址。 | `127.0.0.1` |
| `Listen port` | 本地 bridge 端口，Codex 和 Claude Code 都连接这个端口。 | `18080` |
| `Provider name` | 用于日志和 doctor 输出的显示名称。 | 服务名称或团队名称 |
| `Upstream base URL` | OpenAI-compatible 上游 Base URL，需要包含 `/v1`。 | `https://api.example.com/v1` |
| `Upstream model` | 发送给上游服务的模型名称。 | 上游模型 ID |
| `API key environment variable` | 读取上游 API Key 的环境变量名。 | `LLM_API_KEY` |
| `API key command` | 可选。输出上游 API Key 的命令，适合后台服务和开机自启。 | Keychain 或密钥管理命令 |
| `Temperature` | 发送给上游服务的采样温度。 | 编码场景建议 `0` |

生成配置示例：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 18080
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
llm-coding-bridge doctor --config ~/.llm-coding-bridge/config.json
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

## 4. 检测和启动

检测上游和协议转换：

```bash
llm-coding-bridge doctor --config ~/.llm-coding-bridge/config.json
```

期望输出：

```text
[OK] Custom Provider -> model-name
```

启动服务：

```bash
llm-coding-bridge serve --config ~/.llm-coding-bridge/config.json
```

健康检查：

```bash
curl http://127.0.0.1:18080/health
```

期望输出：

```json
{"ok":true}
```

不调用上游模型的本地服务检测：

```bash
llm-coding-bridge status --config ~/.llm-coding-bridge/config.json
```

完整端点检测：

```bash
llm-coding-bridge doctor --deep --config ~/.llm-coding-bridge/config.json
```

工具调用检测：

```bash
llm-coding-bridge doctor --tools --config ~/.llm-coding-bridge/config.json
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
base_url = "http://127.0.0.1:18080/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

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
base_url = "http://127.0.0.1:18080/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

从 bridge 配置生成 profile：

```bash
llm-coding-bridge codex-profile --config ~/.llm-coding-bridge/config.json --name bridge
```

命令会写入 `~/.codex/bridge.config.toml` 和本地 Codex model catalog。已有生成文件时使用 `--force` 覆盖。

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
llm-coding-bridge install-service --config ~/.llm-coding-bridge/config.json
curl http://127.0.0.1:18080/health
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
base_url = "http://127.0.0.1:18080/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "local"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
```

修改后重启 Codex Desktop。这样会把 bridge 作为 Codex Desktop 默认 provider，也会影响没有使用 `--profile` 的 Codex CLI 会话。

## 6. 配置 Claude Code

输出模板：

```bash
llm-coding-bridge template claude
```

临时验证：

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:18080" \
ANTHROPIC_API_KEY="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

注意：

- `ANTHROPIC_BASE_URL` 不带 `/v1`。
- `--setting-sources local` 用于避免现有用户配置覆盖本次验证。
- `ANTHROPIC_API_KEY` 只是本地客户端兼容值；真实上游认证在 bridge 配置中完成。

长期使用可把环境变量写入 shell profile 或 Claude 配置：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:18080"
export ANTHROPIC_API_KEY="local"
```

## 7. macOS 开机自启

安装 launchd 服务：

```bash
llm-coding-bridge install-service --config ~/.llm-coding-bridge/config.json
```

配置或包升级后重启服务：

```bash
llm-coding-bridge restart-service --config ~/.llm-coding-bridge/config.json
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
llm-coding-bridge doctor --config ~/.llm-coding-bridge/config.json
llm-coding-bridge install-service --config ~/.llm-coding-bridge/config.json
llm-coding-bridge codex-profile --config ~/.llm-coding-bridge/config.json --name bridge
llm-coding-bridge status --config ~/.llm-coding-bridge/config.json
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
llm-coding-bridge doctor --config ~/.llm-coding-bridge/config.json
```

### Claude 没有请求本地服务

先用隔离命令验证：

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:18080" \
ANTHROPIC_API_KEY="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

如果隔离命令可用，通常是已有 Claude 用户配置覆盖了环境变量。

### 端口被占用

修改本地端口：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 18081
  }
}
```

同时更新 Codex 和 Claude 客户端配置。
