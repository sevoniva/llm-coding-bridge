"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { localUrl } = require("./config");
const { backupExisting } = require("./file-safety");

// ponytail: mtime-memoized template load; /v1/models is polled by clients, avoid per-request disk read
let templateCache = { path: null, mtime: 0, value: null };

function loadCodexModelTemplate(home = os.homedir()) {
  const cachePath = path.join(home, ".codex", "models_cache.json");
  let stat;
  try {
    stat = fs.statSync(cachePath);
  } catch {
    templateCache = { path: null, mtime: 0, value: null };
    return null;
  }
  if (templateCache.path === cachePath && templateCache.mtime === stat.mtimeMs) {
    return templateCache.value;
  }
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const models = Array.isArray(cache.models) ? cache.models : [];
    const value = models.find((model) => model.shell_type === "shell_command") || null;
    templateCache = { path: cachePath, mtime: stat.mtimeMs, value };
    return value;
  } catch {
    templateCache = { path: null, mtime: 0, value: null };
    return null;
  }
}

function codexCatalogModel(upstream, home = os.homedir()) {
  const contextWindow = Number(upstream.contextWindow || upstream.context_window || 128000);
  const displayName = upstream.displayName || upstream.name || upstream.model;
  const inputModalities = Array.isArray(upstream.inputModalities)
    ? upstream.inputModalities
    : Array.isArray(upstream.input_modalities)
      ? upstream.input_modalities
      : ["text"];
  const template = loadCodexModelTemplate(home);
  const model = template ? JSON.parse(JSON.stringify(template)) : {
    slug: upstream.model,
    display_name: displayName,
    description: `${displayName} through LLM Coding Bridge.`,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses" },
      { effort: "medium", description: "Balanced reasoning" },
      { effort: "high", description: "Deeper reasoning" },
    ],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    base_instructions: "You are Codex, a coding agent. Follow the user's instructions, use concise engineering prose, and avoid exposing secrets.",
    model_messages: {
      instructions_template:
        "{{ personality }}\n\nYou are Codex, a coding agent. Follow the user's instructions, use concise engineering prose, and avoid exposing secrets.",
      instructions_variables: {
        personality_default: "",
        personality_pragmatic: "Use direct, practical engineering prose. Keep updates concise and action-oriented.",
      },
    },
    additional_speed_tiers: [],
    service_tiers: [],
    upgrade: null,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
  };
  model.slug = upstream.model;
  model.display_name = displayName;
  model.description = `${displayName} through LLM Coding Bridge.`;
  model.context_window = contextWindow;
  model.max_context_window = contextWindow;
  model.input_modalities = inputModalities;
  model.supports_image_detail_original = inputModalities.includes("image");
  model.priority = 1;
  return model;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function writeChecked(file, text, force) {
  if (!force && fs.existsSync(file)) throw new Error(`${file} already exists. Re-run with --force to overwrite.`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function createCodexProfile(config, name, home, force, options = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Profile name may only contain letters, numbers, dots, dashes, and underscores.");
  const root = path.resolve(home);
  const profilePath = path.join(root, ".codex", `${name}.config.toml`);
  const catalogPath = path.join(root, ".llm-coding-bridge", "codex-model-catalog.json");
  const backups = [];
  if (!force) {
    for (const file of [profilePath, catalogPath]) {
      if (fs.existsSync(file)) throw new Error(`${file} already exists. Re-run with --force to overwrite.`);
    }
  } else {
    for (const file of [profilePath, catalogPath]) {
      const backup = backupExisting(file, options);
      if (backup) backups.push(backup);
    }
  }
const upstream = config.defaultUpstream;
  const baseUrl = `${localUrl(config, "/v1")}`;
  const token = config.server.localToken || "local";
  const profile = `model = ${tomlString(upstream.model)}
model_provider = "llm-coding-bridge"
model_reasoning_effort = "none"
disable_response_storage = true
model_catalog_json = ${tomlString(catalogPath)}

[model_providers.llm-coding-bridge]
name = "LLM Coding Bridge"
base_url = ${tomlString(baseUrl)}
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = ${tomlString(token)}
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 600000
`;
  writeChecked(catalogPath, `${JSON.stringify({ models: [codexCatalogModel(upstream)] }, null, 2)}\n`, force);
  writeChecked(profilePath, profile, force);
  console.log(`[OK] wrote ${profilePath}`);
  console.log(`[OK] wrote ${catalogPath}`);
  for (const backup of backups) console.log(`[OK] backup ${backup}`);
  console.log(`Use: codex --profile ${name}`);
  return { profilePath, catalogPath, backups };
}

module.exports = { createCodexProfile, codexCatalogModel, loadCodexModelTemplate };
