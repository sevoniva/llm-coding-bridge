"use strict";

// One process owns one active stream registry.
let activeStreams = null;

function setActive(streams) {
  activeStreams = streams;
}

// terminate: optional () => void, writes a protocol-correct termination frame.
// If omitted, shutdown just ends the response.
function registerStream(res, terminate) {
  if (!activeStreams) return;
  const entry = { res, terminate };
  activeStreams.add(entry);
  res.on("close", () => activeStreams.delete(entry));
}

function terminateAll() {
  if (!activeStreams) return;
  for (const { res, terminate } of activeStreams) {
    if (!res.writableEnded) {
      try {
        if (terminate) terminate();
        else res.end();
      } catch {}
    }
  }
}

module.exports = { setActive, registerStream, terminateAll };
