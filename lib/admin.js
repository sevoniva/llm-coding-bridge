"use strict";

const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { timingSafeEqual } = require("node:crypto");
const { buildAdminStatus } = require("./admin-status");
const { sendJson } = require("./http-util");
const { isLoopbackHost } = require("./config");
const { probeModel, probeAllModels } = require("./doctor");

const MAX_DOCTOR_BODY_BYTES = 16 * 1024;
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const ASSETS = Object.freeze({
  "/admin": Object.freeze({ file: "index.html", contentType: "text/html; charset=utf-8" }),
  "/admin/admin.css": Object.freeze({ file: "admin.css", contentType: "text/css; charset=utf-8" }),
  "/admin/admin.js": Object.freeze({ file: "admin.js", contentType: "text/javascript; charset=utf-8" }),
});
const API_PATHS = new Set(["/admin/api/status", "/admin/api/events", "/admin/api/doctor"]);
const ADMIN_PATHS = new Set([...Object.keys(ASSETS), ...API_PATHS]);
const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const SAFE_CATEGORIES = new Set([
  "success",
  "auth",
  "rate_limit",
  "timeout",
  "network",
  "upstream_5xx",
  "protocol",
  "invalid_request",
  "cancelled",
  "local_config",
]);

function headerValue(value) {
  return Array.isArray(value) ? value[0] : value || "";
}

function isLoopbackPeer(address) {
  if (typeof address !== "string" || net.isIP(address) === 0) return false;
  if (net.isIP(address) === 4) return address.split(".")[0] === "127";
  if (isLoopbackHost(address)) return true;
  const expanded = address.toLowerCase().split(":");
  return expanded.length === 8
    && expanded.slice(0, 7).every((part) => /^0{1,4}$/.test(part))
    && /^0*1$/.test(expanded[7]);
}

function localOriginAllowed(req) {
  const origin = headerValue(req.headers?.origin);
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
  const mediaType = headerValue(req.headers?.["content-type"]).split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json";
}

function tokenMatches(req, token) {
  const authorization = headerValue(req.headers?.authorization);
  const candidate = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!candidate || candidate.length !== token.length) return false;
  try {
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
  } catch {
    return false;
  }
}

function setSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

function sendError(res, status, type, message) {
  sendJson(res, status, { error: { type, message } });
}

async function readDoctorBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_DOCTOR_BODY_BYTES) {
      const error = new Error("Admin payload too large.");
      error.code = "ADMIN_PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const error = new Error("Admin payload is not valid JSON.");
    error.code = "ADMIN_INVALID_JSON";
    throw error;
  }
}

function eventOptions(url) {
  const options = {};
  for (const name of url.searchParams.keys()) {
    if ((name !== "afterSequence" && name !== "limit") || url.searchParams.getAll(name).length !== 1) return null;
    const raw = url.searchParams.get(name);
    if (!/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) return null;
    if (name === "limit" && value > 500) return null;
    options[name] = value;
  }
  return {
    afterSequence: options.afterSequence ?? 0,
    limit: options.limit ?? 500,
  };
}

function configuredAliases(config) {
  const aliases = [];
  for (const route of config?.routes || config?.upstreams || []) {
    const alias = route?.alias || route?.model;
    if (typeof alias === "string" && SAFE_ALIAS.test(alias) && !aliases.includes(alias)) aliases.push(alias);
  }
  return aliases;
}

function doctorRequest(body, aliases) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1) return null;
  if (keys[0] === "model" && typeof body.model === "string" && SAFE_ALIAS.test(body.model)) {
    return aliases.includes(body.model)
      ? { request: Object.freeze({ model: body.model }), aliases: [body.model] }
      : { error: "unknown" };
  }
  if (keys[0] === "allModels" && body.allModels === true && aliases.length > 0) {
    return { request: Object.freeze({ allModels: true }), aliases };
  }
  return null;
}

function safeDoctorRecord(value, alias) {
  if (!value || typeof value !== "object") {
    return { alias, ok: false, category: "protocol", code: "DOCTOR_INVALID_RESULT", elapsedMs: 0 };
  }
  const category = SAFE_CATEGORIES.has(value.category) ? value.category : "protocol";
  const code = typeof value.code === "string" && SAFE_CODE.test(value.code) ? value.code : "DOCTOR_INVALID_RESULT";
  const elapsedMs = Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 ? value.elapsedMs : 0;
  return { alias, ok: value.ok === true, category, code, elapsedMs };
}

function safeDoctorResponse(value, aliases, allModels) {
  if (!allModels) return safeDoctorRecord(value, aliases[0]);
  const rawResults = Array.isArray(value?.results) ? value.results : [];
  return {
    results: aliases.map((alias) => {
      const match = rawResults.find((record) => record?.alias === alias);
      return safeDoctorRecord(match, alias);
    }),
  };
}

function appendDoctorEvent(eventStore, event) {
  try { eventStore?.append(event); } catch {}
}

function createAdminHandler(options = {}) {
  const runtime = options.runtime;
  if (!runtime || typeof runtime !== "object") throw new TypeError("runtime must be an object.");
  const localToken = typeof options.localToken === "string" && options.localToken.trim()
    ? options.localToken
    : null;
  const runDoctor = typeof options.runDoctor === "function"
    ? options.runDoctor
    : async (request) => (
      request.allModels
        ? { results: await probeAllModels(runtime.config) }
        : probeModel(runtime.config, request.model)
    );
  const startedAt = options.startedAt;
  const now = options.now || Date.now;
  const assetRoot = options.assetRoot || path.join(__dirname, "..", "assets", "admin");
  const activeDoctorAliases = new Set();

  return async function handleAdmin(req, res, pathname) {
    if (!ADMIN_PATHS.has(pathname)) return false;
    setSecurityHeaders(res);

    if (!isLoopbackPeer(req.socket?.remoteAddress)) {
      sendError(res, 403, "admin_loopback_required", "Admin access requires a loopback peer.");
      return true;
    }

    if (pathname === "/admin/api/status" || pathname === "/admin/api/events" || ASSETS[pathname]) {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        sendError(res, 405, "admin_method_not_allowed", "Method not allowed.");
        return true;
      }
    } else if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      sendError(res, 405, "admin_method_not_allowed", "Method not allowed.");
      return true;
    }

    if (ASSETS[pathname]) {
      const asset = ASSETS[pathname];
      try {
        const body = await fs.readFile(path.join(assetRoot, asset.file));
        res.writeHead(200, { "Content-Type": asset.contentType });
        res.end(body);
      } catch {
        sendError(res, 404, "admin_asset_not_found", "Admin asset not found.");
      }
      return true;
    }

    if (pathname === "/admin/api/status") {
      sendJson(res, 200, buildAdminStatus(runtime, { startedAt, now, zcode: options.zcode }));
      return true;
    }

    if (pathname === "/admin/api/events") {
      const parsed = new URL(req.url || pathname, "http://127.0.0.1");
      const snapshotOptions = eventOptions(parsed);
      if (!snapshotOptions) {
        sendError(res, 400, "admin_invalid_query", "Invalid event query.");
        return true;
      }
      let events = [];
      try { events = runtime.eventStore?.snapshot(snapshotOptions) || []; } catch {}
      const last = events.at(-1);
      const nextSequence = Number.isSafeInteger(last?.sequence) ? last.sequence : snapshotOptions.afterSequence;
      sendJson(res, 200, { events, nextSequence });
      return true;
    }

    if (!localOriginAllowed(req)) {
      sendError(res, 403, "admin_origin_not_allowed", "Origin not allowed.");
      return true;
    }
    if (!localToken) {
      sendError(res, 409, "admin_auth_not_configured", "Admin actions require a configured local token.");
      return true;
    }
    if (!tokenMatches(req, localToken)) {
      sendError(res, 401, "admin_auth_error", "Unauthorized.");
      return true;
    }
    if (!hasJsonContentType(req)) {
      sendError(res, 415, "admin_unsupported_media_type", "Content-Type must be application/json.");
      return true;
    }

    let body;
    try {
      body = await readDoctorBody(req);
    } catch (error) {
      if (error.code === "ADMIN_PAYLOAD_TOO_LARGE") {
        sendError(res, 413, "admin_payload_too_large", "Payload too large.");
      } else {
        sendError(res, 400, "admin_invalid_json", "Invalid JSON.");
      }
      return true;
    }
    const aliases = configuredAliases(runtime.config);
    const action = doctorRequest(body, aliases);
    if (action?.error === "unknown") {
      sendError(res, 404, "admin_unknown_model", "Unknown model alias.");
      return true;
    }
    if (!action) {
      sendError(res, 400, "admin_invalid_doctor_request", "Invalid doctor request.");
      return true;
    }
    if (action.aliases.some((alias) => activeDoctorAliases.has(alias))) {
      sendError(res, 409, "admin_doctor_busy", "A doctor action is already running for this model.");
      return true;
    }
    for (const alias of action.aliases) {
      activeDoctorAliases.add(alias);
      appendDoctorEvent(runtime.eventStore, { type: "doctor", phase: "doctor_start", model: alias });
    }
    try {
      const rawResult = await runDoctor(action.request);
      const result = safeDoctorResponse(rawResult, action.aliases, action.request.allModels === true);
      const records = action.request.allModels ? result.results : [result];
      for (const record of records) {
        appendDoctorEvent(runtime.eventStore, {
          type: "doctor",
          phase: "doctor_result",
          model: record.alias,
          category: record.category,
          code: record.code,
          elapsedMs: record.elapsedMs,
          outcome: record.ok ? "success" : "failure",
        });
      }
      sendJson(res, 200, result);
    } catch {
      for (const alias of action.aliases) {
        appendDoctorEvent(runtime.eventStore, {
          type: "doctor",
          phase: "doctor_result",
          model: alias,
          category: "network",
          code: "DOCTOR_ACTION_FAILED",
          outcome: "failure",
        });
      }
      sendError(res, 500, "admin_doctor_failed", "Doctor action failed.");
    } finally {
      for (const alias of action.aliases) activeDoctorAliases.delete(alias);
    }
    return true;
  };
}

module.exports = { createAdminHandler, isLoopbackPeer, localOriginAllowed, MAX_DOCTOR_BODY_BYTES };
