# @sevoniva/llm-coding-bridge

[![npm](https://img.shields.io/npm/v/@sevoniva/llm-coding-bridge)](https://www.npmjs.com/package/@sevoniva/llm-coding-bridge)
[![CI](https://github.com/sevoniva/llm-coding-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/sevoniva/llm-coding-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A local, production-oriented protocol bridge for coding clients that need one stable OpenAI-compatible endpoint in front of one or more upstream models.

The bridge keeps client configuration, model aliases, upstream model IDs, credentials, streaming behavior, and route health in one controlled local service. It does not modify client source code and it does not store upstream API keys in the bridge configuration.

## At a glance

```
Codex / Claude / OpenAI-compatible client
                |
                v
      http://127.0.0.1:37629/v1
                |
      LLM Coding Bridge
      - route by model alias
      - normalize protocols
      - enforce timeouts and limits
      - emit streaming heartbeats
                |
                v
        OpenAI-compatible upstream
```

Supported client surfaces:

| Client or protocol | Bridge endpoint | Primary use |
| --- | --- | --- |
| Codex CLI / Codex Desktop | `/v1/responses` | Responses API |
| Claude-compatible clients | `/v1/messages` | Anthropic-compatible messages |
| OpenAI-compatible clients | `/v1/chat/completions` | Chat Completions |
| Client discovery | `/v1/models`, `/health` | Model and service checks |

The default listener is loopback-only. The service has no runtime dependencies and can be managed by macOS launchd.

## Install

Requires Node.js 18 or newer.

```bash
npm install -g @sevoniva/llm-coding-bridge@latest
llm-coding-bridge --help
```

## Quick start

Run the guided setup. It creates `~/.llm-coding-bridge/config.json`, keeps credentials outside that file, and can optionally configure local clients.

```bash
llm-coding-bridge setup
llm-coding-bridge doctor --all-models
llm-coding-bridge install-service
curl -fsS http://127.0.0.1:37629/health
```

Expected health response:

```json
{"ok":true}
```

The local base URL for clients is:

```
http://127.0.0.1:37629/v1
```

For a background service, prefer a command-backed key (for example, macOS Keychain) instead of relying on a shell startup file:

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

Package upgrades do not rewrite the bridge configuration or client profiles. After changing configuration or upgrading the package, run:

```bash
llm-coding-bridge restart-service
llm-coding-bridge status
```

## DeepSeek Harness integration

DeepSeek Harness is supported as a custom provider. No Harness source change is required, and the built-in `deepseek-official` provider remains available alongside the bridge route.

Create a separate `openai-completions` provider with:

- `baseURL: http://127.0.0.1:37629/v1`
- the bridge model alias as the selected model
- a dedicated credential reference for this route
- `supportsReasoningEffort: true` when the selected upstream accepts `reasoning_effort`

Example provider shape:

```yaml
agent-default-model:
  provider: local-bridge
  model: your-model
llm-pi-ai:
  providers:
    local-bridge:
      displayName: Local Bridge
      api: openai-completions
      baseURL: http://127.0.0.1:37629/v1
      apiKeyEnv: LOCAL_BRIDGE_API_KEY
      compat:
        thinkingFormat: openai
        supportsReasoningEffort: true
      models:
        - id: your-model
```

The bridge applies client-specific transport handling at the boundary:

- preserves empty assistant `content` in tool-call history;
- forwards only the documented Harness identity and attribution headers;
- emits an SSE comment plus an empty delta heartbeat during idle periods;
- waits for successful upstream SSE headers so upstream HTTP errors remain HTTP errors;
- normalizes embedded error envelopes that report a real 4xx/5xx status inside an HTTP 200 response.

For upstream gateways that reject the top-level `thinking` extension or impose an output limit, configure the route:

```json
{
  "upstream": {
    "translateThinkingToReasoningEffort": true,
    "maxOutputTokens": 131072
  }
}
```

`translateThinkingToReasoningEffort` removes the unsupported top-level field, preserves an explicit client `reasoning_effort`, and maps disabled thinking to `reasoning_effort: "none"`. `maxOutputTokens` caps numeric `max_tokens` and `max_completion_tokens`. In version 2 configuration, set either option on a provider or override it on an individual model.

## Configuration

### Version 1: one or several upstreams

A minimal configuration uses one upstream:

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

For multiple routes, use `upstreams`. Requests are matched by the client `model` field; an unknown model returns `404 model_not_found` instead of silently selecting a different route.

```json
{
  "server": { "host": "127.0.0.1", "port": 37629 },
  "upstreams": [
    {
      "name": "Fast",
      "baseUrl": "https://fast.example.com/v1",
      "model": "coding-fast",
      "apiKeyEnv": "FAST_API_KEY"
    },
    {
      "name": "Strong",
      "baseUrl": "https://strong.example.com/v1",
      "model": "coding-strong",
      "apiKeyEnv": "STRONG_API_KEY"
    }
  ]
}
```

### Version 2: aliases, providers, and credentials

Version 2 separates the client-facing alias, upstream model ID, provider endpoint, and credential source:

```json
{
  "version": 2,
  "providers": [
    {
      "id": "local-provider",
      "name": "Local Provider",
      "baseUrl": "https://api.example.com/v1",
      "translateThinkingToReasoningEffort": true,
      "maxOutputTokens": 131072,
      "models": [
        {
          "alias": "coding-strong",
          "upstreamModel": "provider-model-id",
          "credentialRef": "coding-strong-key"
        }
      ]
    }
  ],
  "credentials": {
    "coding-strong-key": {
      "source": "env",
      "env": "LLM_API_KEY"
    }
  }
}
```

Use `llm-coding-bridge config migrate --dry-run` before migrating an existing version 1 file. Use `llm-coding-bridge config show --effective` to inspect the resolved route without printing credential values.

### Credential sources

The bridge supports:

- `apiKeyEnv`: read a key from an environment variable;
- `apiKeyCommand`: resolve a key from a command or secret manager;
- `apiKeySource: "client"`: forward the key supplied by a local provider switcher or client.

For client-provided keys, the bridge checks `x-upstream-api-key`, then `Authorization: Bearer ...`, then `x-api-key`. If local authentication is enabled, put the local token in `Authorization` and the upstream key in `x-upstream-api-key`.

Keys resolved from `apiKeyCommand` are cached in memory for 10 minutes by default. Configure `upstream.apiKeyCacheTtlMs` or set it to `0` to disable caching. A 401 response invalidates the cached key immediately.

## Protocol and reliability behavior

The bridge is deliberately conservative about retries: it retries only before semantic output has been observed. Once text, reasoning, refusal, function calls, tool calls, or audio has been emitted, the request is not replayed.

It also provides:

- independent header, first-data, idle, total, and streaming deadlines;
- bounded `Retry-After` handling and per-route cooldown;
- protocol-specific Responses, Chat Completions, and Anthropic-compatible streaming;
- SSE heartbeats that do not count as upstream model output;
- conversion of valid non-SSE JSON responses to SSE for streaming clients;
- aggregation of complete SSE responses for non-streaming Chat Completions;
- request-body, response-body, and SSE-event size limits;
- backpressure-aware streaming and connection cleanup.

For Chat Completions, `server.heartbeatIntervalMs` defaults to 15 seconds. Set it to `0` to disable downstream heartbeats.

## Client setup

### Codex

Generate a dedicated profile:

```bash
llm-coding-bridge codex-profile --name bridge
codex --profile bridge exec --skip-git-repo-check "Reply exactly: OK"
```

Or print the template:

```bash
llm-coding-bridge template codex
```

The generated profile uses:

```text
base_url = http://127.0.0.1:37629/v1
wire_api = responses
```

### Claude-compatible clients

The bridge exposes `/v1/messages` and `/v1/messages/count_tokens`:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:37629"
export ANTHROPIC_AUTH_TOKEN="local"
export ANTHROPIC_DEFAULT_SONNET_MODEL="your-model"
export ANTHROPIC_DEFAULT_OPUS_MODEL="your-model"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="your-model"
```

Print the generated template with:

```bash
llm-coding-bridge template claude
```

### Generic OpenAI-compatible clients

Use:

```
Base URL: http://127.0.0.1:37629/v1
Endpoint: /chat/completions
Model: one of the aliases returned by /v1/models
```

## macOS service management

`llm-coding-bridge install-service` installs a per-user launchd agent at `~/Library/LaunchAgents`. It starts when the user session loads and is configured to restart after an unexpected exit.

```bash
llm-coding-bridge install-service
launchctl list | grep llm-coding-bridge
llm-coding-bridge status
llm-coding-bridge logs --lines 80
llm-coding-bridge restart-service
llm-coding-bridge uninstall-service
```

The service cannot keep an open request alive while macOS is asleep. After wake, clients should retry according to their normal transport policy.

## Local authentication and security

The default loopback listener does not require a token. For a shared or non-loopback listener, set `server.localToken`:

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 37629,
    "localToken": "replace-with-a-random-secret"
  }
}
```

Clients can send `Authorization: Bearer <token>` or `x-api-key: <token>`. `/health` remains unauthenticated. Non-loopback listeners are rejected without a local token.

Security defaults:

- generated config, client profiles, and backups use private file permissions;
- request bodies are capped at 10 MB by default;
- upstream responses are subject to complete-response and cumulative-size limits;
- diagnostic logs contain validated request metadata only; fallback logging never serializes upstream error objects;
- API keys are never committed by the project and should not be placed in the bridge config;
- command-backed keys should use the object form to avoid shell interpretation;
- the package has no install script and does not execute network code during installation.

## Diagnostics

| Symptom | Check |
| --- | --- |
| `ECONNREFUSED 127.0.0.1:37629` | Run `llm-coding-bridge status`, then `llm-coding-bridge restart-service`. |
| `404 model_not_found` | Compare the client model with `curl http://127.0.0.1:37629/v1/models`. |
| `401` from the upstream | Re-check the selected credential source; command-backed keys are refreshed after a 401. |
| Harness receives a stream error as success | Confirm the custom provider uses the bridge `baseURL` and keep the built-in provider separate. |
| Requests stall during long thinking | Keep heartbeats enabled and set `maxOutputTokens` to the tested upstream limit. |
| Works in a shell but not after login | Use `apiKeyCommand` or a launchd-visible credential source instead of a shell-only environment variable. |

## Development

```bash
git clone https://github.com/sevoniva/llm-coding-bridge.git
cd llm-coding-bridge
npm ci
npm run verify
```

The verification gate runs linting, the complete test suite, security and secret scans, the repository and release gates, dependency audit, and an npm pack dry run.

Further reference: [Configuration Guide](docs/configuration.md), [release notes](docs/releases/), and [MIT License](LICENSE).

## 中文快速指南

`@sevoniva/llm-coding-bridge` 是一个本地协议桥接服务，把 Codex、Claude 类客户端、DeepSeek Harness 和其他 OpenAI-compatible 客户端统一接到稳定的本地 `/v1` 端点，再按模型别名转发到一个或多个上游。它不需要修改客户端源码，默认只监听本机回环地址，也不会把上游 API Key 写进 bridge 配置。

安装和启动：

```bash
npm install -g @sevoniva/llm-coding-bridge@latest
llm-coding-bridge setup
llm-coding-bridge doctor --all-models
llm-coding-bridge install-service
curl -fsS http://127.0.0.1:37629/health
```

Harness 配置重点：

- 新增独立的 `openai-completions` 自定义 Provider；
- `baseURL` 使用 `http://127.0.0.1:37629/v1`；
- 选择 bridge 暴露的模型别名；
- 使用独立凭据引用；
- 保留内置的 `deepseek-official` Provider，不需要修改 Harness 源码。

如果上游不接受顶层 `thinking` 或有输出上限，在 bridge 路由中配置 `translateThinkingToReasoningEffort` 和 `maxOutputTokens`。完整配置、协议行为和安全边界见 [Configuration Guide](docs/configuration.md)。

macOS 自启动：

```bash
llm-coding-bridge install-service
llm-coding-bridge status
llm-coding-bridge logs --lines 80
```

该命令安装当前用户的 launchd 服务：登录时启动，异常退出自动拉起；macOS 睡眠时已建立的流式连接仍可能中断。

## License

MIT
