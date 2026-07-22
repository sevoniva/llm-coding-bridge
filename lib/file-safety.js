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
    if (error.code !== "ENOENT") throw error;
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
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
    fsyncDirectory(directory);
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

function openRegularFile(target) {
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY);
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error(`refusing to read a path that is not a regular file: ${target}`);
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error(`refusing to read a file owned by another user: ${target}`);
    }
    return { bytes: fs.readFileSync(descriptor), metadata };
  } finally {
    fs.closeSync(descriptor);
  }
}

function readFileSnapshot(file) {
  const requestedPath = path.resolve(file);
  const resolvedTarget = path.resolve(resolveWriteTarget(requestedPath, false));
  const { bytes, metadata } = openRegularFile(resolvedTarget);
  return Object.freeze({
    requestedPath,
    resolvedTarget,
    bytes,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    device: metadata.dev,
    inode: metadata.ino,
  });
}

function assertSnapshotUnchanged(snapshot) {
  let current;
  try {
    current = readFileSnapshot(snapshot.requestedPath);
  } catch {
    throw new Error("File changed since it was read.");
  }
  if (
    current.resolvedTarget !== snapshot.resolvedTarget
    || current.device !== snapshot.device
    || current.inode !== snapshot.inode
    || current.sha256 !== snapshot.sha256
  ) {
    throw new Error("File changed since it was read.");
  }
}

function verifyPrivateRegularFile(file) {
  const requestedPath = path.resolve(file);
  const target = path.resolve(resolveWriteTarget(requestedPath, false));
  const metadata = fs.statSync(target);
  if (!metadata.isFile()) throw new Error("Private path is not a regular file.");
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Private file is owned by another user.");
  }
  if ((metadata.mode & 0o777) !== PRIVATE_FILE_MODE) throw new Error("Private file mode must be 0600.");
  return Object.freeze({ file: requestedPath, target });
}

function atomicReplacePrivate(snapshot, data) {
  if (!snapshot || typeof snapshot !== "object" || !Buffer.isBuffer(snapshot.bytes)) {
    throw new TypeError("A file snapshot is required.");
  }
  assertSnapshotUnchanged(snapshot);
  const directory = path.dirname(snapshot.resolvedTarget);
  const temporary = path.join(
    directory,
    `.${path.basename(snapshot.resolvedTarget)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`
  );
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY;
  let descriptor;
  let temporaryExists = false;
  try {
    descriptor = fs.openSync(temporary, flags, PRIVATE_FILE_MODE);
    temporaryExists = true;
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    assertSnapshotUnchanged(snapshot);
    fs.renameSync(temporary, snapshot.resolvedTarget);
    temporaryExists = false;
    fs.chmodSync(snapshot.resolvedTarget, PRIVATE_FILE_MODE);
    fsyncDirectory(directory);
    verifyPrivateRegularFile(snapshot.requestedPath);
    return Object.freeze({ file: snapshot.requestedPath, target: snapshot.resolvedTarget });
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (temporaryExists) {
      try { removeIfPresent(temporary); } catch {}
    }
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

module.exports = {
  atomicReplacePrivate,
  backupExisting,
  readFileSnapshot,
  stamp,
  verifyPrivateRegularFile,
  writePrivateFile,
};
