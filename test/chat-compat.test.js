"use strict";

const assert = require("node:assert/strict");

const { parseNonStreamChatResponse, sanitizeChatPayload } = require("../lib/chat-compat");

function sseFrame(body, newline = "\n") {
  return `data: ${JSON.stringify(body)}${newline}${newline}`;
}

function testSanitizeChatPayload() {
  const payload = {
    model: "client-model",
    messages: [{ role: "user", content: "hello" }],
    chat_template_kwargs: { enable_thinking: false },
    extra_body: {
      chat_template_kwargs: { enable_thinking: true },
      keep: { nested: true },
      temperature: 0.25,
    },
  };
  const original = JSON.parse(JSON.stringify(payload));

  const sanitized = sanitizeChatPayload(payload, { stripChatTemplateKwargs: true });

  assert.notStrictEqual(sanitized, payload);
  assert.equal(Object.hasOwn(sanitized, "chat_template_kwargs"), false);
  assert.notStrictEqual(sanitized.extra_body, payload.extra_body);
  assert.deepEqual(sanitized.extra_body, {
    keep: { nested: true },
    temperature: 0.25,
  });
  assert.deepEqual(payload, original);

  const explicitlyDisabled = sanitizeChatPayload(payload, { stripChatTemplateKwargs: false });
  assert.notStrictEqual(explicitlyDisabled, payload);
  assert.deepEqual(explicitlyDisabled, payload);

  const absentOption = sanitizeChatPayload(payload, {});
  assert.notStrictEqual(absentOption, payload);
  assert.deepEqual(absentOption, payload);

  for (const truthyNonBoolean of ["true", 1]) {
    const preserved = sanitizeChatPayload(payload, { stripChatTemplateKwargs: truthyNonBoolean });
    assert.notStrictEqual(preserved, payload);
    assert.deepEqual(preserved, payload);
  }

  const emptyAssistantHistory = {
    messages: [
      { role: "user", content: "before" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "   " },
      { role: "assistant", content: null },
      { role: "assistant", content: [], tool_calls: [] },
      { role: "assistant", content: "", reasoning_content: "kept reasoning" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1" }] },
      { role: "user", content: "after" },
    ],
  };
  const cleaned = sanitizeChatPayload(emptyAssistantHistory);

  assert.deepEqual(cleaned.messages, [
    { role: "user", content: "before" },
    { role: "assistant", reasoning_content: "kept reasoning" },
    { role: "assistant", tool_calls: [{ id: "call_1" }] },
    { role: "user", content: "after" },
  ]);
  assert.deepEqual(emptyAssistantHistory.messages[1], { role: "assistant", content: "" });
}

function testNormalJsonResponse() {
  const completion = {
    id: "chatcmpl-json",
    object: "chat.completion",
    created: 1710000000,
    model: "json-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "normal JSON" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  };

  assert.deepEqual(
    parseNonStreamChatResponse(JSON.stringify(completion), "application/json; charset=utf-8"),
    { completion, normalizedSse: false }
  );
}

function testJsonBodyWithIncorrectSseContentType() {
  const completion = {
    id: "chatcmpl-json-wrong-header",
    object: "chat.completion",
    model: "json-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "normal JSON" },
      finish_reason: "stop",
    }],
  };

  assert.deepEqual(
    parseNonStreamChatResponse(JSON.stringify(completion), "text/event-stream; charset=utf-8"),
    { completion, normalizedSse: false }
  );
}

function testFullCompletionWrappedInSse() {
  const completion = {
    id: "chatcmpl-wrapped",
    object: "chat.completion",
    created: 1710000010,
    model: "wrapped-model",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        refusal: "request refused",
        tool_calls: [{
          id: "call_wrapped",
          type: "function",
          function: { name: "lookup", arguments: "{\"id\":1}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  };
  const body = [
    ": keep-alive\n\n",
    "data:\n\n",
    `event: message\ndata: ${JSON.stringify(completion)}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  assert.deepEqual(parseNonStreamChatResponse(body, "application/json"), {
    completion,
    normalizedSse: true,
  });
}

function testSseTextReasoningAndUsageWithWrongContentType() {
  const firstChunk = {
    id: "chatcmpl-old",
    object: "chat.completion.chunk",
    created: 1710000000,
    model: "old-model",
    system_fingerprint: "fp-old",
    service_tier: "auto",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        reasoning_content: "plan ",
        reasoning: "alternate ",
        content: "Hel",
        refusal: "policy ",
      },
      logprobs: null,
    }],
    usage: { prompt_tokens: 1 },
  };
  const multiLineFrame = JSON.stringify(firstChunk, null, 2)
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  const body = [
    `\uFEFF  \n ${multiLineFrame}\n\n`,
    sseFrame({
      id: "chatcmpl-final",
      created: 1710000001,
      model: "final-model",
      system_fingerprint: "fp-final",
      service_tier: "default",
      choices: [{
        index: 0,
        delta: { reasoning_content: "then answer", reasoning: "path", content: "lo", refusal: "refusal" },
        finish_reason: "stop",
        logprobs: { content: [] },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }),
    sseFrame({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
    "data: [DONE]\n\n",
  ].join("");

  assert.deepEqual(parseNonStreamChatResponse(body, "application/json"), {
    normalizedSse: true,
    completion: {
      id: "chatcmpl-final",
      object: "chat.completion",
      created: 1710000001,
      model: "final-model",
      system_fingerprint: "fp-final",
      service_tier: "default",
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: "Hello",
          reasoning_content: "plan then answer",
          reasoning: "alternate path",
          refusal: "policy refusal",
        },
        finish_reason: "stop",
        logprobs: { content: [] },
      }],
    },
  });
}

function testCrLfAndFinalUnterminatedFrame() {
  const body = [
    sseFrame({
      id: "chatcmpl-crlf",
      choices: [{ index: 0, delta: { content: "A" } }],
    }, "\r\n"),
    `data: ${JSON.stringify({
      id: "chatcmpl-crlf",
      choices: [{ index: 0, delta: { content: "B" }, finish_reason: "stop" }],
    })}`,
  ].join("");

  assert.deepEqual(parseNonStreamChatResponse(body, "text/event-stream; charset=utf-8"), {
    normalizedSse: true,
    completion: {
      id: "chatcmpl-crlf",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "AB" },
        finish_reason: "stop",
      }],
    },
  });
}

function testLogprobsAreAggregatedAcrossChunks() {
  const contentA = {
    token: "A",
    logprob: -0.1,
    bytes: [65],
    top_logprobs: [{ token: "A", logprob: -0.1, bytes: [65] }],
  };
  const contentB = {
    token: "B",
    logprob: -0.2,
    bytes: [66],
    top_logprobs: [{ token: "B", logprob: -0.2, bytes: [66] }],
  };
  const refusalA = { token: "no", logprob: -1.1, bytes: [110, 111] };
  const refusalB = { token: "pe", logprob: -1.2, bytes: [112, 101] };
  const body = [
    sseFrame({
      id: "chatcmpl-logprobs",
      choices: [{
        index: 0,
        delta: { role: "assistant", content: "A" },
        logprobs: { content: [contentA], refusal: [refusalA] },
      }],
    }),
    sseFrame({
      choices: [{
        index: 0,
        delta: { content: "B" },
        finish_reason: "stop",
        logprobs: { content: [contentB], refusal: [refusalB] },
      }],
    }),
    "data: [DONE]\n\n",
  ].join("");

  assert.deepEqual(parseNonStreamChatResponse(body, "text/event-stream"), {
    normalizedSse: true,
    completion: {
      id: "chatcmpl-logprobs",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "AB" },
        finish_reason: "stop",
        logprobs: {
          content: [contentA, contentB],
          refusal: [refusalA, refusalB],
        },
      }],
    },
  });
}

function testToolCallFragments() {
  const body = [
    sseFrame({
      id: "chatcmpl-tools",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            { index: 1, id: "call_", type: "func", function: { name: "sec", arguments: "{\"b\":" } },
            { index: 0, id: "call_", type: "func", function: { name: "fir", arguments: "{\"a\":" } },
          ],
        },
      }],
    }),
    sseFrame({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: "a", type: "tion", function: { name: "st", arguments: "1}" } },
            { index: 1, id: "b", type: "tion", function: { name: "ond", arguments: "2}" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
    }),
    sseFrame({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, id: "call_a", type: "function", function: { name: "first" } },
            { index: 1, id: "call_b", type: "function", function: { name: "second" } },
          ],
        },
      }],
    }),
    "data: [DONE]\n\n",
  ].join("");

  assert.deepEqual(parseNonStreamChatResponse(body, "text/event-stream"), {
    normalizedSse: true,
    completion: {
      id: "chatcmpl-tools",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "first", arguments: "{\"a\":1}" } },
            { id: "call_b", type: "function", function: { name: "second", arguments: "{\"b\":2}" } },
          ],
        },
        finish_reason: "tool_calls",
      }],
    },
  });
}

function testInterleavedChoicesAreAggregatedAndSortedByIndex() {
  const body = [
    sseFrame({
      id: "chatcmpl-multiple",
      choices: [
        { index: 1, delta: { content: "second-" } },
        { index: 0, delta: { content: "first-" } },
      ],
    }),
    sseFrame({
      choices: [
        { index: 0, delta: { content: "choice" }, finish_reason: "stop" },
        { index: 1, delta: { content: "choice" }, finish_reason: "length" },
      ],
    }),
    "data: [DONE]\n\n",
  ].join("");

  assert.deepEqual(parseNonStreamChatResponse(body, "text/event-stream"), {
    normalizedSse: true,
    completion: {
      id: "chatcmpl-multiple",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "first-choice" },
          finish_reason: "stop",
        },
        {
          index: 1,
          message: { role: "assistant", content: "second-choice" },
          finish_reason: "length",
        },
      ],
    },
  });
}

function testInvalidAndEmptySse() {
  assert.throws(
    () => parseNonStreamChatResponse("data: {\"choices\":[}\n\n", "text/event-stream"),
    /invalid SSE data JSON/i
  );
  assert.throws(
    () => parseNonStreamChatResponse("data: {\"usage\":{\"total_tokens\":1}}\n\ndata: [DONE]\n\n", "text/event-stream"),
    /no valid completion chunk/i
  );
  assert.throws(
    () => parseNonStreamChatResponse("data: [DONE]", "application/json"),
    /no valid completion chunk/i
  );
  assert.throws(
    () => parseNonStreamChatResponse(sseFrame({
      choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
    }), "text/event-stream"),
    /ended before completion/i
  );
  assert.throws(
    () => parseNonStreamChatResponse([
      sseFrame({ choices: [{ index: 0, delta: { content: "partial" } }] }),
      sseFrame({ error: { message: "upstream failed" } }),
    ].join(""), "text/event-stream"),
    /upstream error/i
  );
  assert.throws(
    () => parseNonStreamChatResponse([
      sseFrame({ choices: [{ index: 0, message: { role: "assistant", content: "full" }, finish_reason: "stop" }] }),
      sseFrame({ choices: [{ index: 0, delta: { content: "delta" }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ].join(""), "text/event-stream"),
    /mixed full and delta/i
  );
}

function main() {
  testSanitizeChatPayload();
  testNormalJsonResponse();
  testJsonBodyWithIncorrectSseContentType();
  testFullCompletionWrappedInSse();
  testSseTextReasoningAndUsageWithWrongContentType();
  testCrLfAndFinalUnterminatedFrame();
  testLogprobsAreAggregatedAcrossChunks();
  testToolCallFragments();
  testInterleavedChoicesAreAggregatedAndSortedByIndex();
  testInvalidAndEmptySse();
  console.log("chat compatibility tests passed");
}

main();
