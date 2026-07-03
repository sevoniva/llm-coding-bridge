"use strict";

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.input_text || part?.output_text || "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolInputFromArguments(value) {
  const raw = String(value || "");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch {}
  return raw;
}

function parsedToolInput(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && typeof parsed.input === "string" ? parsed.input : null;
  } catch {
    return null;
  }
}

function toolArgumentsString(value, fallback = "{}") {
  if (typeof value === "string") return value || fallback;
  if (value && typeof value === "object") return JSON.stringify(value);
  return fallback;
}

function parseToolArguments(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function approxTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function anthropicText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" || typeof part === "string")
    .map((part) => (typeof part === "string" ? part : part.text || ""))
    .join("\n");
}

module.exports = {
  textFromContent,
  toolInputFromArguments,
  parsedToolInput,
  toolArgumentsString,
  parseToolArguments,
  approxTokens,
  anthropicText,
};
