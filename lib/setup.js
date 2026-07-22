"use strict";

function readSecret(prompt, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Secret input requires an interactive terminal."));
  }

  return new Promise((resolve, reject) => {
    const bytes = [];
    const previousRawMode = input.isRaw === true;
    let settled = false;

    function restore() {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      input.removeListener("end", onEnd);
      try { input.setRawMode(previousRawMode); } catch {}
    }

    function finish(error) {
      if (settled) return;
      settled = true;
      restore();
      output.write("\n");
      if (error) reject(error);
      else resolve(Buffer.from(bytes));
      bytes.fill(0);
    }

    function onError() {
      finish(new Error("Secret input failed."));
    }

    function onEnd() {
      finish(new Error("Secret input ended before a value was provided."));
    }

    function onData(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of data) {
        if (byte === 3) {
          finish(new Error("Secret input was cancelled."));
          return;
        }
        if (byte === 10 || byte === 13) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          if (bytes.length > 0) {
            bytes.pop();
            output.write("\b \b");
          }
          continue;
        }
        if (byte < 32) continue;
        bytes.push(byte);
        output.write(".");
      }
    }

    output.write(prompt);
    input.setRawMode(true);
    input.on("data", onData);
    input.once("error", onError);
    input.once("end", onEnd);
    input.resume();
  });
}

async function storeInteractiveSecret(store, alias, options = {}) {
  const reader = options.reader || (() => readSecret(`API key for ${alias}: `, options));
  const secret = await reader();
  if (!Buffer.isBuffer(secret)) throw new TypeError("Secret reader must return a Buffer.");
  try {
    return await store.save(alias, secret);
  } finally {
    secret.fill(0);
  }
}

module.exports = { readSecret, storeInteractiveSecret };
