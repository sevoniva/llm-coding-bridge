"use strict";

const assert = require("node:assert/strict");

const { parseCliArgs } = require("../lib/cli-args");

function parses(argv, expected) {
  assert.deepEqual(parseCliArgs(argv), Object.freeze(expected));
}

function rejects(argv, pattern) {
  assert.throws(() => parseCliArgs(argv), pattern, argv.join(" "));
}

parses([], { command: "help" });
parses(["--help"], { command: "help" });
parses(["setup"], { command: "setup" });
parses(["setup", "--profile", "/tmp/profile.json", "--advanced", "--home", "/tmp/home"], {
  command: "setup",
  profile: "/tmp/profile.json",
  advanced: true,
  home: "/tmp/home",
});
parses(["config", "show", "--effective", "--config", "/tmp/config.json"], {
  command: "config",
  action: "show",
  effective: true,
  config: "/tmp/config.json",
});
parses(["config", "migrate", "--dry-run", "--home", "/tmp/home"], {
  command: "config",
  action: "migrate",
  dryRun: true,
  home: "/tmp/home",
});
parses(["client", "add", "zcode", "--dry-run", "--home", "/tmp/home"], {
  command: "client",
  action: "add",
  client: "zcode",
  dryRun: true,
  home: "/tmp/home",
});
parses(["client", "remove", "zcode", "--yes", "--restart-zcode"], {
  command: "client",
  action: "remove",
  client: "zcode",
  yes: true,
  restartZcode: true,
});
parses(["client", "rollback", "zcode", "--backup", "/tmp/zcode.bak"], {
  command: "client",
  action: "rollback",
  client: "zcode",
  backup: "/tmp/zcode.bak",
});
parses(["doctor", "--model", "coding-fast", "--config", "/tmp/config.json"], {
  command: "doctor",
  model: "coding-fast",
  config: "/tmp/config.json",
});
parses(["doctor", "--all-models"], { command: "doctor", allModels: true });

// Explicit 0.6 compatibility commands remain parseable.
parses(["init", "--out", "/tmp/config.json", "--home", "/tmp/home", "--no-doctor"], {
  command: "init",
  out: "/tmp/config.json",
  home: "/tmp/home",
  doctor: false,
});
parses(["serve", "-c", "/tmp/config.json"], { command: "serve", config: "/tmp/config.json" });
parses(["doctor", "--deep", "--tools"], { command: "doctor", deep: true, tools: true });
parses(["status"], { command: "status" });
parses(["codex-profile", "--name", "bridge", "--force"], {
  command: "codex-profile",
  name: "bridge",
  force: true,
});
parses(["template", "zcode"], { command: "template", template: "zcode" });
parses(["logs", "--lines", "120"], { command: "logs", lines: 120 });
parses(["install-service", "--config", "/tmp/config.json"], {
  command: "install-service",
  config: "/tmp/config.json",
});
parses(["restart-service"], { command: "restart-service" });
parses(["uninstall-service"], { command: "uninstall-service" });

rejects(["setup", "--profile"], /--profile requires a value/);
rejects(["doctor", "--model", "--deep"], /--model requires a value/);
rejects(["logs", "--lines", "NaN"], /--lines must be a positive integer/);
rejects(["setup", "--advanced", "--advanced"], /Duplicate option: --advanced/);
rejects(["serve", "--config", "a.json", "-c", "b.json"], /Duplicate option: --config/);
rejects(["doctor", "--model", "one", "--all-models"], /cannot be used together/);
rejects(["config", "show"], /config show requires --effective/);
rejects(["config", "show", "--effective", "--dry-run"], /Unknown option: --dry-run/);
rejects(["client", "add", "codex"], /Unknown client: codex/);
rejects(["client", "rollback", "zcode"], /requires --backup/);
rejects(["client", "add", "zcode", "extra"], /Unexpected positional argument: extra/);
rejects(["config", "unknown"], /Unknown config action: unknown/);
rejects(["client", "unknown", "zcode"], /Unknown client action: unknown/);
rejects(["serve", "extra"], /Unexpected positional argument: extra/);
rejects(["template", "unknown"], /Unknown template: unknown/);
rejects(["wat"], /Unknown command: wat/);

const frozen = parseCliArgs(["setup"]);
assert.equal(Object.isFrozen(frozen), true);
assert.throws(() => { frozen.command = "serve"; }, TypeError);

console.log("CLI argument tests passed");
