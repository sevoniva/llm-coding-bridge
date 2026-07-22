"use strict";

(() => {
  const POLL_INTERVAL_MS = 5000;
  const REQUEST_TIMEOUT_MS = 4000;
  const MAX_RENDERED_EVENTS = 200;
  const controllers = new Set();
  let pollTimer = null;
  let pollActive = false;
  let connected = false;
  let eventCursor = 0;
  let eventCount = 0;
  let noticeSource = "";

  const byId = (id) => document.getElementById(id);
  const elements = {
    signal: byId("connection-signal"),
    connection: byId("connection-state"),
    notice: byId("notice"),
    version: byId("bridge-version"),
    uptime: byId("runtime-uptime"),
    routeCount: byId("runtime-routes"),
    credentialCount: byId("runtime-credentials"),
    config: byId("runtime-config"),
    routesBody: byId("routes-body"),
    token: byId("admin-token"),
    doctorAll: byId("doctor-all"),
    zcodeState: byId("zcode-state"),
    zcodeVersion: byId("zcode-version"),
    zcodeManaged: byId("zcode-managed"),
    zcodeAliases: byId("zcode-aliases"),
    zcodeMode: byId("zcode-mode"),
    zcodeVerified: byId("zcode-verified"),
    timeline: byId("event-timeline"),
    eventCount: byId("event-count"),
  };

  function setText(element, value) {
    element.textContent = value === null || value === undefined || value === "" ? "-" : String(value);
  }

  function formatDuration(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "-";
    const seconds = Math.floor(milliseconds / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  function formatTime(timestamp) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) return "-";
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function formatDate(timestamp) {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) return "-";
    return new Date(timestamp).toLocaleString();
  }

  function showNotice(message, tone = "warning", source = "general") {
    elements.notice.hidden = !message;
    elements.notice.textContent = message || "";
    elements.notice.dataset.tone = tone;
    noticeSource = message ? source : "";
  }

  function clearConnectionNotice() {
    if (noticeSource === "connection") showNotice("");
  }

  function setConnection(isConnected) {
    connected = isConnected;
    elements.signal.className = `signal ${isConnected ? "is-online" : "is-error"}`;
    setText(elements.connection, isConnected ? "Live" : "Unavailable");
  }

  async function requestJson(pathname, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    controllers.add(controller);
    try {
      const response = await fetch(pathname, {
        ...options,
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(body.error?.type || `HTTP_${response.status}`);
        error.status = response.status;
        throw error;
      }
      return body;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  function stateElement(value, tone) {
    const state = document.createElement("span");
    state.className = `state ${tone ? `is-${tone}` : ""}`;
    state.textContent = value;
    return state;
  }

  function capabilityText(capabilities) {
    const parts = [];
    if (Number.isSafeInteger(capabilities?.contextWindow)) parts.push(`${capabilities.contextWindow} ctx`);
    if (Array.isArray(capabilities?.inputModalities)) parts.push(capabilities.inputModalities.join(" + "));
    if (capabilities?.reasoning === true) parts.push("reasoning");
    return parts.join(" / ");
  }

  function routeTone(route) {
    if (!route.credentialAvailable || route.health === "open") return "error";
    if (route.health === "half_open" || route.consecutiveFailures > 0) return "warning";
    return "good";
  }

  function appendCell(row, value, className = "") {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = value;
    row.append(cell);
    return cell;
  }

  function renderRoutes(routes) {
    elements.routesBody.replaceChildren();
    if (!routes.length) {
      const row = document.createElement("tr");
      const cell = appendCell(row, "No routes", "empty");
      cell.colSpan = 6;
      elements.routesBody.append(row);
      return;
    }

    for (const route of routes) {
      const row = document.createElement("tr");
      const aliasCell = document.createElement("td");
      const alias = document.createElement("span");
      alias.className = "route-alias";
      alias.textContent = route.alias;
      aliasCell.append(alias);
      const capabilities = capabilityText(route.capabilities);
      if (capabilities) {
        const detail = document.createElement("span");
        detail.className = "route-capabilities";
        detail.textContent = capabilities;
        aliasCell.append(detail);
      }
      row.append(aliasCell);

      const healthCell = document.createElement("td");
      healthCell.append(stateElement(route.health || "closed", routeTone(route)));
      row.append(healthCell);
      appendCell(row, route.credentialAvailable ? "Available" : "Unavailable");
      appendCell(row, Number.isSafeInteger(route.consecutiveFailures) ? route.consecutiveFailures : 0);
      appendCell(row, formatDate(route.lastSuccessAt));

      const actionCell = document.createElement("td");
      const button = document.createElement("button");
      button.className = "route-action";
      button.type = "button";
      button.textContent = "Run";
      button.addEventListener("click", () => runDoctor({ model: route.alias }, button));
      actionCell.append(button);
      row.append(actionCell);
      elements.routesBody.append(row);
    }
  }

  function renderZcode(zcode = {}) {
    let state = "Not verified";
    let tone = "";
    if (zcode.previewOnly) {
      state = "Preview only";
      tone = "warning";
    } else if (zcode.supported && zcode.managedProviderPresent) {
      state = "Managed";
      tone = "good";
    } else if (zcode.supported) {
      state = "Available";
      tone = "warning";
    }
    elements.zcodeState.className = `state ${tone ? `is-${tone}` : ""}`;
    setText(elements.zcodeState, state);
    setText(elements.zcodeVersion, zcode.version);
    setText(elements.zcodeManaged, zcode.managedProviderPresent ? "Present" : "Absent");
    setText(elements.zcodeAliases, Number.isSafeInteger(zcode.aliasCount) ? zcode.aliasCount : 0);
    setText(elements.zcodeMode, zcode.privateMode ? "0600" : "Unverified");
    setText(elements.zcodeVerified, formatDate(zcode.lastVerifiedAt));
  }

  function renderStatus(status) {
    const routes = Array.isArray(status.routes) ? status.routes : [];
    setText(elements.version, `v${status.version || "-"}`);
    setText(elements.uptime, formatDuration(status.uptimeMs));
    setText(elements.routeCount, routes.length);
    setText(elements.credentialCount, `${routes.filter((route) => route.credentialAvailable).length}/${routes.length}`);
    setText(elements.config, status.configPath);
    elements.config.title = status.configPath || "";
    renderRoutes(routes);
    renderZcode(status.zcode);
  }

  function eventDetail(event) {
    const details = [];
    for (const [key, label, suffix] of [
      ["attempt", "attempt", ""],
      ["status", "HTTP", ""],
      ["delayMs", "backoff", "ms"],
      ["heartbeatCount", "heartbeats", ""],
      ["elapsedMs", "elapsed", "ms"],
    ]) {
      if (Number.isSafeInteger(event[key])) details.push(`${label} ${event[key]}${suffix}`);
    }
    for (const key of ["category", "code", "outcome"]) {
      if (typeof event[key] === "string") details.push(event[key]);
    }
    return details.join(" / ") || "-";
  }

  function appendEvents(events) {
    if (!Array.isArray(events) || events.length === 0) return;
    if (elements.timeline.querySelector(".empty")) elements.timeline.replaceChildren();
    for (const event of events) {
      const item = document.createElement("li");
      const time = document.createElement("time");
      time.dateTime = Number.isSafeInteger(event.timestamp) ? new Date(event.timestamp).toISOString() : "";
      time.textContent = formatTime(event.timestamp);
      const model = document.createElement("span");
      model.className = "event-model";
      model.textContent = event.model || event.route || "bridge";
      const phase = document.createElement("span");
      phase.className = "event-phase";
      phase.textContent = event.phase || event.type || "event";
      const detail = document.createElement("span");
      detail.className = "event-detail";
      detail.textContent = eventDetail(event);
      item.append(time, model, phase, detail);
      elements.timeline.append(item);
      eventCount += 1;
    }
    while (elements.timeline.children.length > MAX_RENDERED_EVENTS) elements.timeline.firstElementChild.remove();
    setText(elements.eventCount, `${eventCount} ${eventCount === 1 ? "event" : "events"}`);
  }

  async function loadStatus() {
    const status = await requestJson("/admin/api/status");
    if (!connected) {
      eventCursor = 0;
      eventCount = 0;
      elements.timeline.replaceChildren();
    }
    renderStatus(status);
    setConnection(true);
  }

  async function loadEvents() {
    const result = await requestJson(`/admin/api/events?afterSequence=${eventCursor}&limit=100`);
    appendEvents(result.events);
    if (Number.isSafeInteger(result.nextSequence) && result.nextSequence >= eventCursor) {
      eventCursor = result.nextSequence;
    }
  }

  async function poll() {
    if (pollActive || document.hidden) return;
    pollActive = true;
    try {
      await loadStatus();
      await loadEvents();
      clearConnectionNotice();
    } catch (error) {
      setConnection(false);
      showNotice(
        error.name === "AbortError" ? "Request timed out" : "Bridge status unavailable",
        "error",
        "connection"
      );
    } finally {
      pollActive = false;
    }
  }

  async function runDoctor(body, button) {
    const token = elements.token.value;
    if (!token) {
      showNotice("Local token required", "warning", "doctor");
      elements.token.focus();
      return;
    }
    button.disabled = true;
    showNotice("");
    try {
      const result = await requestJson("/admin/api/doctor", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const records = Array.isArray(result.results) ? result.results : [result];
      const failures = records.filter((record) => record.ok !== true);
      await poll();
      showNotice(
        failures.length ? `${failures.length} probe failed` : "Probe complete",
        failures.length ? "error" : "success",
        "doctor"
      );
    } catch (error) {
      const message = error.status === 401
        ? "Local token rejected"
        : error.status === 409
          ? "Probe already running"
          : "Probe failed";
      showNotice(message, "error", "doctor");
    } finally {
      button.disabled = false;
    }
  }

  function stopPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
    for (const controller of controllers) controller.abort();
  }

  function startPolling() {
    stopPolling();
    if (document.hidden) return;
    poll();
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  }

  elements.doctorAll.addEventListener("click", () => runDoctor({ allModels: true }, elements.doctorAll));
  document.addEventListener("visibilitychange", startPolling);
  window.addEventListener("beforeunload", stopPolling);
  startPolling();
})();
