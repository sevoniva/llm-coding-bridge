"use strict";

// ponytail: 模块级单例，单进程内只有一个 activeStreams 集合，无需多实例
let activeStreams = null;

function setActive(streams) {
  activeStreams = streams;
}

function registerStream(res) {
  if (!activeStreams) return;
  activeStreams.add(res);
  res.on("close", () => activeStreams.delete(res));
}

module.exports = { setActive, registerStream };
