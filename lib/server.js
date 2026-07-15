"use strict";

const http = require("node:http");
const { timingSafeEqual } = require("node:crypto");
const { resolveUpstream, localUrl, isLoopbackHost } = require("./config");
const { setActive, terminateAll } = require("./streams");
const { sendJson, debug } = require("./http-util");
const { handleChat } = require("./converters/chat");
const { handleResponses } = require("./converters/responses");
const { handleAnthropicMessages, handleAnthropicTokenCount } = require("./converters/anthropic");
const { codexCatalogModel } = require("./codex-profile");

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;
const POST_API_PATHS = new Set([
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/responses/compact",
  "/v1/messages",
  "/v1/messages/count_tokens",
]);

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value || "";
}

function localOriginAllowed(req) {
  const origin = headerValue(req.headers.origin);
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && isLoopbackHost(parsed.hostname)
      && parsed.pathname === "/"
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function hasJsonContentType(req) {
  const mediaType = headerValue(req.headers["content-type"]).split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json";
}

function requestApiKey(req, localToken) {
  const upstreamKey = headerValue(req.headers["x-upstream-api-key"]);
  if (upstreamKey) return upstreamKey;
  const auth = headerValue(req.headers.authorization);
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (bearer && bearer !== localToken) return bearer;
  const xKey = headerValue(req.headers["x-api-key"]);
  return xKey !== localToken ? xKey : "";
}

function upstreamForRequest(config, model, req, localToken) {
  const upstream = resolveUpstream(config, model);
  if (!upstream || upstream.apiKeySource !== "client") return upstream;
  const clientApiKey = requestApiKey(req, localToken);
  return clientApiKey ? { ...upstream, clientApiKey } : upstream;
}

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
  const configuredToken = config.server.localToken;
  const localToken = typeof configuredToken === "string" && configuredToken.trim() ? configuredToken : null;
  if (!isLoopbackHost(config.server.host) && !localToken) {
    throw new Error("server.localToken is required when server.host is not a loopback address.");
  }
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
      const pathname = new URL(req.url || "/", localUrl(config)).pathname;
      if (req.method === "GET" && pathname === "/health") {
        debug("GET /health");
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && POST_API_PATHS.has(pathname)) {
        if (!localOriginAllowed(req)) {
          sendJson(res, 403, { error: { message: "Origin not allowed.", type: "origin_not_allowed" } });
          return;
        }
        if (!hasJsonContentType(req)) {
          sendJson(res, 415, { error: { message: "Content-Type must be application/json.", type: "unsupported_media_type" } });
          return;
        }
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
        const upstream = upstreamForRequest(config, payload.model, req, localToken);
        if (!upstream) return sendJson(res, 404, { error: { message: "Unknown model.", type: "model_not_found" } });
        if (upstream.apiKeySource === "client" && !upstream.clientApiKey) return sendJson(res, 401, { error: { message: "Missing client API key.", type: "auth_error" } });
        await handleChat(upstream, payload, res);
        return;
      }
      if (req.method === "POST" && (pathname === "/v1/responses" || pathname === "/v1/responses/compact")) {
        const payload = await readJson(req, maxBodyBytes);
        const input = Array.isArray(payload.input) ? payload.input.length : typeof payload.input;
        debug(`POST ${pathname} stream=${payload.stream === true} input=${input}`);
        const upstream = upstreamForRequest(config, payload.model, req, localToken);
        if (!upstream) return sendJson(res, 404, { error: { message: "Unknown model.", type: "model_not_found" } });
        if (upstream.apiKeySource === "client" && !upstream.clientApiKey) return sendJson(res, 401, { error: { message: "Missing client API key.", type: "auth_error" } });
        await handleResponses(upstream, payload, res);
        return;
      }
      if (req.method === "POST" && pathname === "/v1/messages") {
        debug("POST /v1/messages");
        const payload = await readJson(req, maxBodyBytes);
        const upstream = upstreamForRequest(config, payload.model, req, localToken);
        if (!upstream) return sendJson(res, 404, { error: { message: "Unknown model.", type: "model_not_found" } });
        if (upstream.apiKeySource === "client" && !upstream.clientApiKey) return sendJson(res, 401, { error: { message: "Missing client API key.", type: "auth_error" } });
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
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error.statusCode === 413) {
        sendJson(res, 413, { error: { message: "Payload too large.", type: "payload_too_large" } });
        // Destroy after the response flushes so the client receives the 413
        // rather than an ECONNRESET, while still stopping an oversized upload.
        res.on("finish", () => req.destroy());
      } else {
        sendJson(res, 500, { error: { message: "Bridge request failed.", type: "bridge_error" } });
      }
    }
  });

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(config.server.port, config.server.host, () => {
    const { port } = server.address();
    const listeningConfig = { ...config, server: { ...config.server, port } };
    console.error(`LLM Coding Bridge listening on ${localUrl(listeningConfig, "/v1")}`);
  });
  return server;
}

module.exports = { startServer, readJson };
