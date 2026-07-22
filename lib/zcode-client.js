"use strict";

const VERSION = /^3\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function zcodeVerificationStatus(input = {}) {
  const aliasCount = safeInteger(input.aliasCount);
  return Object.freeze({
    version: typeof input.version === "string" && VERSION.test(input.version) ? input.version : null,
    supported: input.supported === true,
    previewOnly: input.previewOnly === true,
    managedProviderPresent: input.managedProviderPresent === true,
    aliasCount: aliasCount ?? 0,
    privateMode: input.privateMode === true,
    lastVerifiedAt: safeInteger(input.lastVerifiedAt),
  });
}

module.exports = { zcodeVerificationStatus };
