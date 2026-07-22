"use strict";

const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");

const { createCredentialStore } = require("../lib/credential-store");
const { readSecret, storeInteractiveSecret } = require("../lib/setup");

const suppliedSecret = "synthetic-sensitive-value";

function assertSafe(value) {
  assert.doesNotMatch(JSON.stringify(value), new RegExp(suppliedSecret));
}

function testMacCredentialIsolationAndCommands() {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
  };
  const store = createCredentialStore({ platform: "darwin", run });
  const fast = store.descriptor("coding-fast");
  const strong = store.descriptor("coding-strong");

  assert.equal(fast.source, "command");
  assert.equal(fast.command.command, "/usr/bin/security");
  assert.deepEqual(fast.command.args.slice(0, 2), ["find-generic-password", "-s"]);
  assert.notEqual(fast.command.args[2], strong.command.args[2]);
  assert.notEqual(fast.command.args[4], strong.command.args[4]);
  assert.deepEqual(fast.command.args.slice(-1), ["-w"]);

  const saved = store.save("coding-fast", Buffer.from(suppliedSecret));
  assert.deepEqual(saved, { ok: true, code: "SAVED", descriptor: fast });
  assert.equal(calls[0].command, "/usr/bin/security");
  assert.deepEqual(calls[0].args.slice(0, 2), ["add-generic-password", "-U"]);
  assert.equal(calls[0].args.at(-1), suppliedSecret);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 10000);
  assert.equal(calls[0].options.stdio, "pipe");
  assertSafe(saved);

  const deleted = store.delete("coding-fast");
  assert.deepEqual(deleted, { ok: true, code: "DELETED" });
  assert.equal(calls[1].args[0], "delete-generic-password");
  assertSafe(deleted);
}

function testReadAndFailuresNeverExposeChildOutput() {
  let operation = "read";
  const store = createCredentialStore({
    platform: "darwin",
    run(command, args) {
      assert.equal(command, "/usr/bin/security");
      if (operation === "read") {
        assert.equal(args[0], "find-generic-password");
        return { status: 0, stdout: Buffer.from(`${suppliedSecret}\n`), stderr: Buffer.from("") };
      }
      return {
        status: 7,
        stdout: Buffer.from(suppliedSecret),
        stderr: Buffer.from(suppliedSecret),
        error: new Error(suppliedSecret),
      };
    },
  });
  assert.equal(store.read("coding-fast"), suppliedSecret);

  operation = "fail";
  for (const invoke of [
    () => store.save("coding-fast", suppliedSecret),
    () => store.read("coding-fast"),
    () => store.delete("coding-fast"),
  ]) {
    assert.throws(invoke, (error) => {
      assert.equal(error.code, "CREDENTIAL_STORE_COMMAND_FAILED");
      assertSafe({ message: error.message, code: error.code });
      return true;
    });
  }
}

function testPortableEnvironmentDescriptors() {
  const env = { LLM_CODING_BRIDGE_ALIAS_636F64696E672D66617374_API_KEY: suppliedSecret };
  const store = createCredentialStore({ platform: "linux", env });
  const fast = store.descriptor("coding-fast");
  const underscore = store.descriptor("coding_fast");
  assert.deepEqual(fast, {
    source: "env",
    env: "LLM_CODING_BRIDGE_ALIAS_636F64696E672D66617374_API_KEY",
  });
  assert.match(fast.env, /^[A-Z_][A-Z0-9_]*$/);
  assert.notEqual(fast.env, underscore.env);
  assert.equal(store.read("coding-fast"), suppliedSecret);
  assert.deepEqual(store.save("coding-fast", suppliedSecret), {
    ok: false,
    code: "ENV_MANAGED_EXTERNALLY",
    descriptor: fast,
  });
  assert.deepEqual(store.delete("coding-fast"), { ok: false, code: "ENV_MANAGED_EXTERNALLY" });
  assert.throws(() => store.descriptor("unsafe alias"), /safe alias/i);
}

async function testNoEchoReaderAndZeroing() {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  const rawTransitions = [];
  input.setRawMode = (value) => {
    rawTransitions.push(value);
    input.isRaw = value;
  };
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk; });

  const pending = readSecret("API key: ", { input, output });
  input.write(Buffer.from(suppliedSecret));
  input.write(Buffer.from("\r"));
  const secret = await pending;
  assert.equal(secret.toString("utf8"), suppliedSecret);
  assert.deepEqual(rawTransitions, [true, false]);
  assert.match(rendered, /^API key: \.+\n$/);
  assert.doesNotMatch(rendered, new RegExp(suppliedSecret));

  const temporary = Buffer.from(suppliedSecret);
  let observed = "";
  const result = await storeInteractiveSecret({
    save(alias, value) {
      assert.equal(alias, "coding-fast");
      observed = value.toString("utf8");
      return { ok: true, code: "SAVED" };
    },
  }, "coding-fast", { reader: async () => temporary });
  assert.equal(observed, suppliedSecret);
  assert.deepEqual(result, { ok: true, code: "SAVED" });
  assert.equal(temporary.every((byte) => byte === 0), true);

  const nonTty = new PassThrough();
  nonTty.isTTY = false;
  await assert.rejects(() => readSecret("API key: ", { input: nonTty, output }), /interactive terminal/i);
}

async function main() {
  testMacCredentialIsolationAndCommands();
  testReadAndFailuresNeverExposeChildOutput();
  testPortableEnvironmentDescriptors();
  await testNoEchoReaderAndZeroing();
  console.log("credential store tests passed");
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
