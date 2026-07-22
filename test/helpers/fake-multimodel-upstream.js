"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");

const MAX_BODY_BYTES = 1024 * 1024;
const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function cloneSteps(steps) {
  if (!Array.isArray(steps)) throw new TypeError("script steps must be an array");
  return steps.map((step) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new TypeError("each script step must be an object");
    }
    return { ...step };
  });
}

function authorizationMatches(header, expectedKey) {
  const actual = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expectedKey);
  if (actualBytes.length !== expectedBytes.length) {
    const padded = Buffer.alloc(expectedBytes.length);
    actualBytes.copy(padded, 0, 0, Math.min(actualBytes.length, padded.length));
    crypto.timingSafeEqual(padded, expectedBytes);
    return false;
  }
  return crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function completion(model, content) {
  return {
    id: `chatcmpl-fixture-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      logprobs: null,
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}

function chunk(model, delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: `chatcmpl-fixture-${crypto.randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  })}\n\n`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (part) => {
      bytes += part.length;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error("request body too large");
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(part);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function startFakeMultiModel(options = {}) {
  const inputRoutes = options.routes;
  const clock = options.clock || Date.now;
  if (!Array.isArray(inputRoutes) || inputRoutes.length === 0) throw new TypeError("routes must be a non-empty array");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");

  const routes = new Map();
  const aliasesByModel = new Map();
  const scripts = new Map();
  const requests = new Map();
  const timers = new Set();
  for (const route of inputRoutes) {
    if (!route || !SAFE_ALIAS.test(route.alias || "") || typeof route.model !== "string" || !route.model ||
      typeof route.key !== "string" || !route.key) {
      throw new TypeError("each route requires a safe alias, model, and key");
    }
    if (routes.has(route.alias) || aliasesByModel.has(route.model)) throw new Error("route aliases and models must be unique");
    routes.set(route.alias, { alias: route.alias, model: route.model, key: route.key });
    aliasesByModel.set(route.model, route.alias);
    requests.set(route.alias, []);
    scripts.set(route.alias, cloneSteps(options.scripts?.[route.alias] || []));
  }

  function later(res, delayMs, callback) {
    const delay = Number(delayMs);
    assert.equal(Number.isSafeInteger(delay) && delay >= 0, true, "delayMs must be a non-negative integer");
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!res.destroyed) callback();
    }, delay);
    timers.add(timer);
    res.once("close", () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  }

  function writeSse(res, route, content) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.write(chunk(route.model, { role: "assistant", content }));
    res.end(`data: ${JSON.stringify({
      id: `chatcmpl-fixture-${crypto.randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: route.model,
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    })}\n\ndata: [DONE]\n\n`);
  }

  function runStep(req, res, route, step) {
    const content = typeof step.content === "string" ? step.content : "OK";
    if (step.type === "status") {
      res.writeHead(step.status, {
        "Content-Type": "application/json",
        ...(step.retryAfter === undefined ? {} : { "Retry-After": String(step.retryAfter) }),
      });
      res.end(JSON.stringify({ error: { type: "fixture_error", code: `fixture_${step.status}`, message: "Fixture failure." } }));
      return;
    }
    if (step.type === "invalid_json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{");
      return;
    }
    if (step.type === "json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(completion(route.model, content)));
      return;
    }
    if (step.type === "sse") {
      writeSse(res, route, content);
      return;
    }
    if (step.type === "slow_first") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.flushHeaders();
      later(res, step.delayMs, () => {
        res.write(chunk(route.model, { role: "assistant", content }));
        res.end("data: [DONE]\n\n");
      });
      return;
    }
    if (step.type === "idle_gap") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write(chunk(route.model, { role: "assistant" }));
      later(res, step.delayMs, () => {
        res.write(chunk(route.model, { content }));
        res.end("data: [DONE]\n\n");
      });
      return;
    }
    if (step.type === "reset") {
      req.socket.destroy();
      return;
    }
    if (step.type === "reset_after_content") {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write(chunk(route.model, { role: "assistant", content }));
      later(res, 5, () => req.socket.destroy());
      return;
    }
    throw new Error(`unsupported fake upstream step: ${step.type}`);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || new URL(req.url || "/", "http://127.0.0.1").pathname !== "/v1/chat/completions") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      const body = await readJsonBody(req);
      const alias = aliasesByModel.get(body.model);
      if (!alias) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unknown model" } }));
        return;
      }
      const route = routes.get(alias);
      const matched = authorizationMatches(req.headers.authorization, route.key);
      const records = requests.get(alias);
      records.push(Object.freeze({
        requestNumber: records.length + 1,
        model: body.model,
        authorizationMatched: matched,
        timestamp: clock(),
      }));
      if (!matched) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { type: "authentication_error", message: "invalid credential" } }));
        return;
      }
      const step = scripts.get(alias).shift() || { type: "json", content: "OK" };
      runStep(req, res, route, step);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status = error.statusCode || 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: status === 413 ? "request too large" : "fixture failure" } }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return Object.freeze({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requestsFor(alias) {
      if (!requests.has(alias)) throw new Error("unknown alias");
      return requests.get(alias).map((record) => ({ ...record }));
    },
    rotateKey(alias, nextKey) {
      if (!routes.has(alias)) throw new Error("unknown alias");
      if (typeof nextKey !== "string" || !nextKey) throw new TypeError("nextKey must be a non-empty string");
      routes.get(alias).key = nextKey;
    },
    setScript(alias, nextSteps) {
      if (!routes.has(alias)) throw new Error("unknown alias");
      scripts.set(alias, cloneSteps(nextSteps));
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      server.closeAllConnections?.();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  });
}

module.exports = { startFakeMultiModel };
