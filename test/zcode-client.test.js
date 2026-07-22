"use strict";

const assert = require("node:assert/strict");
const { zcodeVerificationStatus } = require("../lib/zcode-client");

assert.deepEqual(zcodeVerificationStatus(), {
  version: null,
  supported: false,
  previewOnly: false,
  managedProviderPresent: false,
  aliasCount: 0,
  privateMode: false,
  lastVerifiedAt: null,
});

assert.deepEqual(zcodeVerificationStatus({
  version: "unknown version with secret",
  supported: "yes",
  previewOnly: true,
  managedProviderPresent: true,
  aliasCount: -1,
  privateMode: true,
  lastVerifiedAt: -1,
}), {
  version: null,
  supported: false,
  previewOnly: true,
  managedProviderPresent: true,
  aliasCount: 0,
  privateMode: true,
  lastVerifiedAt: null,
});

console.log("zcode client tests passed");
