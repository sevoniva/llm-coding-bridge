"use strict";

const fs = require("node:fs");

function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function backupExisting(file, options = {}) {
  if (!fs.existsSync(file)) return null;
  const backup = `${file}.bak-${stamp(options.now)}`;
  try {
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    throw new Error(`backup failed for ${file}: ${error.message}`);
  }
  return backup;
}

module.exports = { backupExisting, stamp };
