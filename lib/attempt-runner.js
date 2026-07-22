"use strict";

const { BridgeError, classifyError } = require("./bridge-error");
const { bustApiKey } = require("./config");
const { DEFAULT_RETRY_POLICY, decideRetry } = require("./retry-policy");
const { fetchUpstream, readUpstreamChatCompletion, eachSseData } = require("./upstream");

function cancelledError() {
  const error = new Error("Request cancelled.");
  error.name = "AbortError";
  error.code = "CLIENT_CANCELLED";
  return error;
}

function waitWithSignal(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(cancelledError());
  if (delayMs === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(cancelledError());
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function responseError(response) {
  const error = new Error(`Upstream HTTP ${response.status}.`);
  error.status = response.status;
  error.headers = response.headers;
  return error;
}

function completionData(completion) {
  return JSON.stringify({
    choices: (completion?.choices || []).map((choice) => ({
      delta: choice?.delta || choice?.message || {},
    })),
  });
}

function appendEvent(eventStore, event) {
  try { eventStore?.append(event); } catch {}
}

function finishState(requestState, phase) {
  if (["completed", "failed", "cancelled"].includes(requestState.phase)) return;
  if (phase === "completed" && requestState.phase !== "streaming") return;
  requestState.transition(phase);
}

async function runChatAttempts(options) {
  const {
    route,
    payload,
    requestState,
    credentialResolver,
    healthRegistry,
    policy = DEFAULT_RETRY_POLICY,
    signal,
    eventStore,
    onHeaders,
    onData,
    onJsonCompletion,
    wait = waitWithSignal,
    random = Math.random,
    now = Date.now,
  } = options || {};
  if (!route || !payload || !requestState || !healthRegistry) {
    throw new TypeError("route, payload, requestState, and healthRegistry are required.");
  }
  if (typeof wait !== "function" || typeof random !== "function" || typeof now !== "function") {
    throw new TypeError("wait, random, and now must be functions.");
  }
  const alias = route.alias || route.model;
  const attemptRoute = credentialResolver ? { ...route, credentialResolver } : route;
  let cumulativeDelayMs = 0;
  let credentialRefreshAttempted = false;

  if (requestState.phase === "accepted") requestState.transition("connecting");
  if (requestState.phase === "connecting") requestState.transition("waiting_first_content");

  while (true) {
    if (signal?.aborted) {
      const error = classifyError(cancelledError(), { phase: requestState.phase, model: alias, requestId: requestState.requestId });
      finishState(requestState, "cancelled");
      throw error;
    }

    const health = healthRegistry.acquire(alias, now());
    if (!health.allowed) {
      const remainingWaitMs = policy.maxCumulativeDelayMs - cumulativeDelayMs;
      if (health.waitMs > 0 && health.waitMs <= remainingWaitMs) {
        appendEvent(eventStore, {
          type: "cooldown_wait",
          phase: requestState.phase,
          requestId: requestState.requestId,
          model: alias,
          delayMs: health.waitMs,
        });
        try {
          await wait(health.waitMs, signal);
          if (signal?.aborted) throw cancelledError();
        } catch (rawError) {
          const error = classifyError(rawError, { phase: requestState.phase, model: alias, requestId: requestState.requestId });
          finishState(requestState, error.category === "cancelled" ? "cancelled" : "failed");
          throw error;
        }
        cumulativeDelayMs += health.waitMs;
        continue;
      }
      const error = new BridgeError({
        category: "network",
        phase: requestState.phase,
        retryable: true,
        scope: "model_route",
        code: health.reason === "half_open_probe_active" ? "HALF_OPEN_PROBE_ACTIVE" : "ROUTE_COOLDOWN_ACTIVE",
        model: alias,
        requestId: requestState.requestId,
      });
      finishState(requestState, "failed");
      throw error;
    }

    const attempt = requestState.nextAttempt();
    appendEvent(eventStore, {
      type: "attempt_start",
      phase: requestState.phase,
      requestId: requestState.requestId,
      model: alias,
      attempt,
    });

    try {
      const response = await fetchUpstream(attemptRoute, payload, { signal });
      if (onHeaders) await onHeaders(response, attempt);
      if (!response.ok) {
        const error = responseError(response);
        await response.body?.cancel(error).catch(() => {});
        throw error;
      }

      const contentType = response.headers.get("content-type") || "";
      if (payload.stream === true && contentType.includes("text/event-stream") && response.body) {
        await eachSseData(response.body, async (data) => {
          requestState.observeChatData(data);
          if (onData) await onData(data, attempt);
        }, { signal, maxSseEventBytes: route.maxSseEventBytes });
        finishState(requestState, "completed");
        healthRegistry.recordSuccess(alias);
        appendEvent(eventStore, {
          type: "attempt_success",
          phase: requestState.phase,
          requestId: requestState.requestId,
          model: alias,
          attempt,
          status: response.status,
        });
        return Object.freeze({ response, streamed: true, attempt });
      }

      const completion = await readUpstreamChatCompletion(response);
      requestState.observeChatData(completionData(completion));
      if (onJsonCompletion) await onJsonCompletion(completion, response, attempt);
      finishState(requestState, "completed");
      healthRegistry.recordSuccess(alias);
      appendEvent(eventStore, {
        type: "attempt_success",
        phase: requestState.phase,
        requestId: requestState.requestId,
        model: alias,
        attempt,
        status: response.status,
      });
      return Object.freeze({ response, completion, streamed: false, attempt });
    } catch (rawError) {
      const source = signal?.aborted ? cancelledError() : rawError;
      const error = classifyError(source, {
        phase: source?.phase || requestState.phase,
        model: alias,
        requestId: requestState.requestId,
        attempt,
        now: now(),
      });
      appendEvent(eventStore, {
        type: "attempt_failure",
        phase: error.phase,
        requestId: requestState.requestId,
        model: alias,
        attempt,
        status: error.status,
        category: error.category,
        code: error.code,
      });

      const retry = decideRetry({
        error,
        attempt,
        semanticContentStarted: requestState.semanticContentStarted,
        cumulativeDelayMs,
        credentialRefreshAttempted,
        policy,
        random,
      });
      if (!retry.retry) {
        healthRegistry.recordTerminalFailure(alias, error, now());
        finishState(requestState, error.category === "cancelled" ? "cancelled" : "failed");
        throw error;
      }

      if (health.probe) healthRegistry.recordTerminalFailure(alias, error, now());
      if (retry.refreshCredential) {
        if (credentialResolver && route.credentialRef) credentialResolver.invalidate(route.credentialRef);
        else bustApiKey(route);
        credentialRefreshAttempted = true;
      }
      appendEvent(eventStore, {
        type: "retry_scheduled",
        phase: requestState.phase,
        requestId: requestState.requestId,
        model: alias,
        attempt,
        delayMs: retry.delayMs,
        outcome: retry.reason,
      });
      try {
        await wait(retry.delayMs, signal);
        if (signal?.aborted) throw cancelledError();
      } catch (rawWaitError) {
        const waitError = classifyError(rawWaitError, {
          phase: requestState.phase,
          model: alias,
          requestId: requestState.requestId,
          attempt,
        });
        finishState(requestState, waitError.category === "cancelled" ? "cancelled" : "failed");
        throw waitError;
      }
      cumulativeDelayMs += retry.delayMs;
    }
  }
}

module.exports = { runChatAttempts, waitWithSignal };
