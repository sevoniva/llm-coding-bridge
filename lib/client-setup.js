"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { localUrl } = require("./config");
const { codexCatalogModel } = require("./codex-profile");
const { backupExisting, writePrivateFile } = require("./file-safety");

function authToken(config) {
  if (config.defaultUpstream.apiKeySource === "client" && !config.server.localToken) {
    return process.env.LLM_CODING_BRIDGE_CLIENT_API_KEY || "<upstream-api-key>";
  }
  return config.server.localToken || "local";
}

function claudeEnv(config) {
  const model = config.defaultUpstream.model;
  return {
    ANTHROPIC_BASE_URL: localUrl(config),
    ANTHROPIC_AUTH_TOKEN: authToken(config),
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
  };
}

function configureClaudeCode(config, home = os.homedir(), options = {}) {
  const file = path.join(path.resolve(home), ".claude", "settings.json");
  let settings = {};
  if (fs.existsSync(file)) {
    settings = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Claude settings must be a JSON object.");
  }
  const backup = backupExisting(file, options);
  settings.env = { ...(settings.env && typeof settings.env === "object" ? settings.env : {}), ...claudeEnv(config) };
  writePrivateFile(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, backup };
}

function codexProviderToml(config, catalogPath) {
  const model = config.defaultUpstream.model;
  const baseUrl = localUrl(config, "/v1");
  const token = authToken(config);
  const q = (value) => JSON.stringify(String(value));
  return `model = ${q(model)}
model_provider = "llm-coding-bridge"
model_reasoning_effort = "none"
disable_response_storage = true
model_catalog_json = ${q(catalogPath)}

[model_providers.llm-coding-bridge]
name = "LLM Coding Bridge"
base_url = ${q(baseUrl)}
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = ${q(token)}
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
`;
}

function stripCodexBridgeToml(text) {
  const out = [];
  let table = null;
  let skipProvider = false;
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      table = header[1];
      skipProvider = table === "model_providers.llm-coding-bridge";
      if (!skipProvider) out.push(line);
      continue;
    }
    if (skipProvider) continue;
    if (!table && /^\s*(model|model_provider|model_reasoning_effort|disable_response_storage|model_catalog_json)\s*=/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

function configureCodexDesktop(config, home = os.homedir(), options = {}) {
  const root = path.resolve(home);
  const file = path.join(root, ".codex", "config.toml");
  const catalogPath = path.join(root, ".llm-coding-bridge", "codex-model-catalog.json");
  const catalogBackup = backupExisting(catalogPath, options);
  const backup = backupExisting(file, options);
  writePrivateFile(catalogPath, `${JSON.stringify({ models: [codexCatalogModel(config.defaultUpstream, root)] }, null, 2)}\n`);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const kept = stripCodexBridgeToml(existing);
  const next = `${codexProviderToml(config, catalogPath)}${kept ? `\n${kept}\n` : ""}`;
  writePrivateFile(file, next);
  return { file, backup, catalogPath, catalogBackup };
}

function manualClaude(config) {
  const model = config.defaultUpstream.model;
  const token = config.server.localToken ? "<server.localToken>" : authToken(config);
  return `Claude Code:
  ANTHROPIC_BASE_URL=${localUrl(config)}
  ANTHROPIC_AUTH_TOKEN=${token}
  ANTHROPIC_DEFAULT_SONNET_MODEL=${model}
  ANTHROPIC_DEFAULT_OPUS_MODEL=${model}
  ANTHROPIC_DEFAULT_HAIKU_MODEL=${model}`;
}

function manualCodexCli(config, name = "bridge") {
  return `Codex CLI:
  llm-coding-bridge codex-profile --config ${config.path} --name ${name}
  codex --profile ${name} exec --skip-git-repo-check "Reply exactly: OK"`;
}

function manualCodexDesktop(config) {
  return `Codex Desktop:
  llm-coding-bridge template codex-desktop
  Edit ~/.codex/config.toml, then restart Codex Desktop.
  Local base_url: ${localUrl(config, "/v1")}`;
}

function manualSetup(config) {
  return `Manual setup / 手工配置:
${manualClaude(config)}

${manualCodexCli(config)}

${manualCodexDesktop(config)}`;
}

module.exports = {
  configureClaudeCode,
  configureCodexDesktop,
  manualClaude,
  manualCodexCli,
  manualCodexDesktop,
  manualSetup,
};
