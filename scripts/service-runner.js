"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Console } = require("node:console");
const { loadConfig } = require("../lib/config");
const { startServer } = require("../lib/server");

// The Windows task hosts the bridge in this process; logs append across restarts.
const [configFile, logDirectory] = process.argv.slice(2);
fs.mkdirSync(logDirectory, { recursive: true });
global.console = new Console({
  stdout: fs.createWriteStream(path.join(logDirectory, "out.log"), { flags: "a", mode: 0o600 }),
  stderr: fs.createWriteStream(path.join(logDirectory, "err.log"), { flags: "a", mode: 0o600 }),
});
process.on("uncaughtException", (error) => {
  const reason = error.code === "EADDRINUSE" ? "Port already in use. Stop the other bridge process." : "Run config validate and doctor to check configuration and credentials.";
  console.error(`[FAIL] ${reason}`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100);
});
startServer(loadConfig(configFile));
