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
llm-coding-bridge init --out ~/.llm-coding-bridge/config.json
```

For complete setup instructions, see [Configuration Guide](docs/configuration.md).

The generated file looks like this:

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
    "temperature": 0
  }
}
```

API keys are not stored in the config file:

```bash
export LLM_API_KEY="..."
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

## Run

```bash
llm-coding-bridge doctor --config ~/.llm-coding-bridge/config.json
llm-coding-bridge serve --config ~/.llm-coding-bridge/config.json
```

Then point clients at:

```text
http://127.0.0.1:18080/v1
```

## Codex

Print the Codex template:

```bash
llm-coding-bridge template codex
```

Minimal Codex config:

```toml
model = "your-model"
model_provider = "llm-coding-bridge"

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

Use this as a separate Codex profile if you do not want to change your default Codex Desktop setup.

## Claude

Print the Claude template:

```bash
llm-coding-bridge template claude
```

Use the local Anthropic-compatible endpoint:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:18080"
export ANTHROPIC_API_KEY="local"
```

The bridge exposes `/v1/messages` and `/v1/messages/count_tokens`.

For an isolated Claude Code check that does not read existing user settings:

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:18080" \
ANTHROPIC_API_KEY="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

## macOS autostart

```bash
llm-coding-bridge install-service --config ~/.llm-coding-bridge/config.json
```

Remove it:

```bash
llm-coding-bridge uninstall-service
```

Logs are written to:

```text
~/.llm-coding-bridge/logs/
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
llm-coding-bridge init --out ~/.llm-coding-bridge/config.json
```

检测配置：

```bash
export LLM_API_KEY="..."
llm-coding-bridge doctor --config ~/.llm-coding-bridge/config.json
```

启动服务：

```bash
llm-coding-bridge serve --config ~/.llm-coding-bridge/config.json
```

Codex 的 `base_url` 配为：

```text
http://127.0.0.1:18080/v1
```

Claude 类客户端配置：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:18080"
export ANTHROPIC_API_KEY="local"
```

如果只想临时验证，不读取现有 `~/.claude/settings.json`：

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:18080" \
ANTHROPIC_API_KEY="local" \
claude --bare --setting-sources local -p --model sonnet "Reply exactly: OK"
```

长期使用建议安装 macOS 自启动，并用 Keychain 命令读取 API Key，避免依赖终端环境变量。

## Security

- Config files should not contain API keys.
- Use `apiKeyEnv` for interactive sessions.
- Use `apiKeyCommand` for background services.
- Do not commit private config files.
