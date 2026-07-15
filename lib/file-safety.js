"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

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

function removeIfPresent(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") return;
  }
}

function resolveWriteTarget(file, exclusive) {
  if (exclusive) return file;
  let metadata;
  try {
    metadata = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return file;
    throw error;
  }
  if (!metadata.isSymbolicLink()) return file;

  let target;
  try {
    target = fs.realpathSync(file);
  } catch (error) {
    throw new Error(`refusing to replace unresolved symbolic link ${file}: ${error.message}`);
  }
  const targetMetadata = fs.statSync(target);
  if (!targetMetadata.isFile()) {
    throw new Error(`refusing to write symbolic link target that is not a regular file: ${file}`);
  }
  if (typeof process.getuid === "function" && targetMetadata.uid !== process.getuid()) {
    throw new Error(`refusing to write symbolic link target owned by another user: ${file}`);
  }
  return target;
}

function writePrivateFile(file, data, options = {}) {
  const requestedDirectory = path.dirname(file);
  fs.mkdirSync(requestedDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const destination = resolveWriteTarget(file, Boolean(options.exclusive));
  const directory = path.dirname(destination);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
  let descriptor;
  let destinationDescriptor;
  let destinationReserved = false;
  let temporaryExists = false;
  try {
    descriptor = fs.openSync(temporary, flags, PRIVATE_FILE_MODE);
    temporaryExists = true;
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    if (options.exclusive) {
      destinationDescriptor = fs.openSync(destination, flags, PRIVATE_FILE_MODE);
      destinationReserved = true;
      fs.closeSync(destinationDescriptor);
      destinationDescriptor = undefined;
    }

    fs.renameSync(temporary, destination);
    temporaryExists = false;
    destinationReserved = false;
    fs.chmodSync(destination, PRIVATE_FILE_MODE);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (destinationDescriptor !== undefined) {
      try { fs.closeSync(destinationDescriptor); } catch {}
    }
    if (temporaryExists) removeIfPresent(temporary);
    if (destinationReserved) removeIfPresent(destination);
    throw error;
  }
}

function backupExisting(file, options = {}) {
  if (!fs.existsSync(file)) return null;
  const backup = `${file}.bak-${stamp(options.now)}`;
  try {
    writePrivateFile(backup, fs.readFileSync(file), { exclusive: true });
  } catch (error) {
    throw new Error(`backup failed for ${file}: ${error.message}`);
  }
  return backup;
}

module.exports = { backupExisting, stamp, writePrivateFile };
