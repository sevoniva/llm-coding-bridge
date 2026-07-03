"use strict";

const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");
const { resolveUpstream } = require("./config");
const { setActive, terminateAll } = require("./streams");
const { sendJson, debug } = require("./http-util");
const { handleChat } = require("./converters/chat");
const { handleResponses } = require("./converters/responses");
const { handleAnthropicMessages, handleAnthropicTokenCount } = require("./converters/anthropic");
const { codexCatalogModel } = require("./codex-profile");

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

async function readJson(req, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const err = new Error("Payload too large.");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function startServer(config) {
  const localToken = config.server.localToken || null;
  const maxBodyBytes = Number(config.server.maxBodyBytes) || DEFAULT_MAX_BODY_BYTES;

  function authorized(req) {
    if (!localToken) return true;
    const auth = req.headers.authorization || "";
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const xKey = req.headers["x-api-key"] || "";
    const candidates = [bearer, xKey].filter((c) => c && c.length === localToken.length);
    for (const candidate of candidates) {
      try {
        if (timingSafeEqual(Buffer.from(candidate), Buffer.from(localToken))) return true;
      } catch {}
    }
    return false;
  }

  const activeStreams = new Set();
  setActive(activeStreams);

  function shutdown() {
    terminateAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
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
      if (req.method === "GET" && pathname === "/v1/models") {
        debug("GET /v1/models");
        const data = config.upstreams.map((u) => ({ id: u.model, object: "model", created: 0, owned_by: u.name || "upstream" }));
        const models = config.upstreams.map((u) => codexCatalogModel(u));
        sendJson(res, 200, { object: "list", data, models });
        return;
      }
      if (req.method === "POST" && pathname === "/v1/chat/completions") {
        debug("POST /v1/chat/completions");
        const payload = await readJson(req, maxBodyBytes);
        const upstream = resolveUpstream(config, payload.model);
        if (!upstream) return sendJson(res, 404, { error: { message: `Unknown model: ${payload.model}`, type: "model_not_found" } });
        await handleChat(upstream, payload, res);
        return;
      }
      if (req.method === "POST" && (pathname === "/v1/responses" || pathname === "/v1/responses/compact")) {
        const payload = await readJson(req, maxBodyBytes);
        const input = Array.isArray(payload.input) ? payload.input.length : typeof payload.input;
        debug(`POST ${pathname} stream=${payload.stream === true} input=${input}`);
        const upstream = resolveUpstream(config, payload.model);
        if (!upstream) return sendJson(res, 404, { error: { message: `Unknown model: ${payload.model}`, type: "model_not_found" } });
        await handleResponses(upstream, payload, res);
        return;
      }
      if (req.method === "POST" && pathname === "/v1/messages") {
        debug("POST /v1/messages");
        const payload = await readJson(req, maxBodyBytes);
        const upstream = resolveUpstream(config, payload.model);
        if (!upstream) return sendJson(res, 404, { error: { message: `Unknown model: ${payload.model}`, type: "model_not_found" } });
        await handleAnthropicMessages(upstream, payload, res);
        return;
      }
      if (req.method === "POST" && pathname === "/v1/messages/count_tokens") {
        debug("POST /v1/messages/count_tokens");
        handleAnthropicTokenCount(await readJson(req, maxBodyBytes), res);
        return;
      }
      sendJson(res, 404, { error: { message: `Not found: ${req.method} ${req.url}`, type: "not_found" } });
    } catch (error) {
      if (error.statusCode === 413) {
        sendJson(res, 413, { error: { message: "Payload too large.", type: "payload_too_large" } });
        req.destroy();
      } else {
        sendJson(res, 500, { error: { message: "Bridge request failed.", type: "bridge_error" } });
      }
    }
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(config.server.port, config.server.host, () => {
    console.error(`LLM Coding Bridge listening on http://${config.server.host}:${config.server.port}/v1`);
  });
  return server;
}

module.exports = { startServer, readJson };
