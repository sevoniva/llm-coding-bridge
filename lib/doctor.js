"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { localUrl } = require("./config");
const { fetchUpstreamJson } = require("./upstream");
const { classifyError } = require("./bridge-error");

const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

function routeAlias(route) {
  const alias = route?.alias || route?.model;
  return typeof alias === "string" && SAFE_ALIAS.test(alias) ? alias : null;
}

function routeForAlias(config, alias) {
  const routes = config.routes || config.upstreams || [];
  return routes.find((route) => routeAlias(route) === alias) || null;
}

function safeNow(now) {
  try {
    const value = now();
    if (Number.isSafeInteger(value) && value >= 0) return value;
  } catch {}
  return Date.now();
}

function probeRecord(alias, ok, category, code, startedAt, now) {
  return Object.freeze({
    alias,
    ok,
    category,
    code,
    elapsedMs: Math.max(0, safeNow(now) - startedAt),
  });
}

async function probeModel(config, alias, options = {}) {
  const now = options.now || Date.now;
  if (typeof now !== "function") throw new TypeError("options.now must be a function.");
  const startedAt = safeNow(now);
  const route = routeForAlias(config, alias);
  if (!route) return probeRecord(String(alias || "unknown"), false, "local_config", "DOCTOR_UNKNOWN_MODEL", startedAt, now);

  let upstream = config.credentialResolver
    ? { ...route, credentialResolver: config.credentialResolver }
    : route;
  if (upstream.apiKeySource === "client") {
    const clientApiKey = options.clientApiKey || doctorClientKey(config);
    upstream = { ...upstream, clientApiKey };
  }
  const fetchJson = options.fetchJson || fetchUpstreamJson;
  if (typeof fetchJson !== "function") throw new TypeError("options.fetchJson must be a function.");

  try {
    const chat = await fetchJson(upstream, {
      model: upstream.model || upstream.upstreamModel,
      messages: [
        { role: "system", content: "Follow the user's instruction exactly. Do not explain." },
        { role: "user", content: "Reply with exactly: OK" },
      ],
      temperature: 0,
    });
    const text = typeof chat?.choices?.[0]?.message?.content === "string"
      ? chat.choices[0].message.content.trim()
      : "";
    if (text !== "OK") {
      return probeRecord(alias, false, "protocol", "DOCTOR_UNEXPECTED_RESPONSE", startedAt, now);
    }
    return probeRecord(alias, true, "success", "OK", startedAt, now);
  } catch (error) {
    const elapsedMs = Math.max(0, safeNow(now) - startedAt);
    const classified = classifyError(error, { phase: "doctor", model: alias, elapsedMs });
    return Object.freeze({
      alias,
      ok: false,
      category: classified.category,
      code: classified.code || "UPSTREAM_UNKNOWN",
      elapsedMs,
    });
  }
}

async function probeAllModels(config, options = {}) {
  const aliases = [];
  for (const route of config.routes || config.upstreams || []) {
    const alias = routeAlias(route);
    if (alias && !aliases.includes(alias)) aliases.push(alias);
  }
  const results = [];
  for (const alias of aliases) results.push(await probeModel(config, alias, options));
  return Object.freeze(results);
}

function doctorClientKey(config) {
  if (config.defaultUpstream.apiKeySource !== "client") return "";
  const key = process.env.LLM_CODING_BRIDGE_CLIENT_API_KEY || "";
  if (!key) throw new Error("Set LLM_CODING_BRIDGE_CLIENT_API_KEY to run doctor with apiKeySource=client.");
  return key;
}

async function fetchLocalJson(config, method, pathname, body = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const clientKey = doctorClientKey(config);
  const token = config.server.localToken || clientKey || "local";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-api-key": token };
  if (config.server.localToken && clientKey) headers["x-upstream-api-key"] = clientKey;
  try {
    const response = await fetch(localUrl(config, pathname), {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function doctor(config, deep = false, tools = false) {
  const upstream = config.defaultUpstream;
  const alias = routeAlias(upstream);
  const result = await probeModel(config, alias);
  if (!result.ok) throw new Error(`Doctor probe failed (${result.category}/${result.code}).`);
  console.log(`[OK] ${upstream.name || "upstream"} -> ${alias}`);
  if (deep) await deepDoctor(config);
  if (tools) await toolsDoctor(config);
}

async function deepDoctor(config) {
  const upstream = config.defaultUpstream;
  const clientModel = routeAlias(upstream);
  const health = await fetchLocalJson(config, "GET", "/health");
  if (health.ok !== true) throw new Error("Local health check failed.");
  const models = await fetchLocalJson(config, "GET", "/v1/models");
  if (!models.data?.[0]?.id || !models.models?.[0]?.slug || !models.models?.[0]?.model_messages) {
    throw new Error("Local models response is not compatible with Codex.");
  }
  const responses = await fetchLocalJson(config, "POST", "/v1/responses", {
    model: clientModel,
    input: "Reply with exactly: OK",
    stream: false,
  });
  if ((responses.output_text || "").trim() !== "OK") throw new Error("Local responses endpoint failed.");
  const messages = await fetchLocalJson(config, "POST", "/v1/messages", {
    model: clientModel,
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    stream: false,
  });
  if ((messages.content?.[0]?.text || "").trim() !== "OK") throw new Error("Local messages endpoint failed.");
  const compact = await fetchLocalJson(config, "POST", "/v1/responses/compact", {
    model: clientModel,
    input: "Reply with exactly: OK",
    stream: false,
  });
  if ((compact.output_text || "").trim() !== "OK") throw new Error("Local responses compact endpoint failed.");
  console.log("[OK] health");
  console.log("[OK] models");
  console.log("[OK] responses endpoint");
  console.log("[OK] responses compact endpoint");
  console.log("[OK] messages endpoint");
}

async function toolsDoctor(config) {
  const upstream = config.defaultUpstream;
  const clientModel = routeAlias(upstream);
  const fn = await fetchLocalJson(config, "POST", "/v1/responses", {
    model: clientModel,
    input: "Call the tool named bridge_probe with input exactly OK. Do not answer in text.",
    stream: false,
    tools: [{ type: "function", function: { name: "bridge_probe", description: "Probe tool.", parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } } }],
  });
  if (!fn.output?.some((item) => item.type === "function_call" && item.name === "bridge_probe")) {
    throw new Error("Local function tool probe failed.");
  }
  const custom = await fetchLocalJson(config, "POST", "/v1/responses", {
    model: clientModel,
    input: "Call the custom tool named bridge_freeform with input exactly OK. Do not answer in text.",
    stream: false,
    tools: [{ type: "custom", name: "bridge_freeform", description: "Freeform probe tool." }],
  });
  if (!custom.output?.some((item) => item.type === "custom_tool_call" && item.name === "bridge_freeform")) {
    throw new Error("Local custom tool probe failed.");
  }
  const search = await fetchLocalJson(config, "POST", "/v1/responses", {
    model: clientModel,
    input: "Call the tool_search tool with query exactly bridge probe. Do not answer in text.",
    stream: false,
    tools: [{ type: "tool_search" }],
  });
  if (!search.output?.some((item) => item.type === "tool_search_call" && item.arguments?.query)) {
    throw new Error("Local tool-search probe failed.");
  }
  console.log("[OK] function tool call");
  console.log("[OK] custom tool call");
  console.log("[OK] tool-search call");
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
}

function serviceLabel() {
  return "com.sevoniva.llm-coding-bridge";
}

function printCheck(ok, label, detail = "") {
  console.log(`[${ok ? "OK" : "FAIL"}] ${label}${detail ? ` ${detail}` : ""}`);
  return ok;
}

async function status(config) {
  let ok = true;
  printCheck(true, "package", `@sevoniva/llm-coding-bridge ${packageVersion()}`);
  printCheck(true, "config", config.path);
  try {
    const health = await fetchLocalJson(config, "GET", "/health");
    ok = printCheck(health.ok === true, "health", localUrl(config, "/health")) && ok;
  } catch (error) {
    ok = printCheck(false, "health", error.message) && ok;
  }
  try {
    const models = await fetchLocalJson(config, "GET", "/v1/models");
    const model = models.data?.[0]?.id;
    const catalog = models.models?.[0];
    ok = printCheck(Boolean(model && catalog?.slug && catalog?.model_messages), "models", model || "missing") && ok;
  } catch (error) {
    ok = printCheck(false, "models", error.message) && ok;
  }
  if (process.platform === "darwin") {
    const result = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${serviceLabel()}`], { encoding: "utf8" });
    console.log(`[${result.status === 0 ? "OK" : "WARN"}] launchd ${serviceLabel()}`);
  }
  console.log(`logs ${path.join(os.homedir(), ".llm-coding-bridge", "logs")}`);
  if (!ok) process.exitCode = 1;
}

module.exports = {
  doctor,
  probeModel,
  probeAllModels,
  deepDoctor,
  toolsDoctor,
  status,
  fetchLocalJson,
  packageVersion,
  serviceLabel,
};
