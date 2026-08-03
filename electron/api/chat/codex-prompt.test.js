import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildCodexConversationPrompt,
  chunkTextInput,
  getCodexErrorDetail,
  getCodexSessionId,
  getLatestUserMessage,
  getLatestUserPrompt,
  isCodexResumeFailure,
  serializeCodexMessage,
} from "./codex-prompt.js";

const makeTextMessage = (role, text) => ({
  parts: [{ text, type: "text" }],
  role,
});

test("extracts a trimmed Codex session id or null", () => {
  assert.equal(getCodexSessionId("  session-1  "), "session-1");
  assert.equal(getCodexSessionId("   "), null);
  assert.equal(getCodexSessionId(42), null);
  assert.equal(getCodexSessionId(undefined), null);
});

test("recognizes Codex resume failures case-insensitively", () => {
  assert.equal(isCodexResumeFailure("Thread/Resume Failed: boom"), true);
  assert.equal(
    isCodexResumeFailure("error: No rollout found for thread id abc"),
    true,
  );
  assert.equal(isCodexResumeFailure("some other error"), false);
  assert.equal(isCodexResumeFailure(null), false);
});

test("extracts Codex error detail from direct, JSON-encoded, and nested messages", () => {
  assert.equal(
    getCodexErrorDetail({ message: "plain failure" }),
    "plain failure",
  );
  assert.equal(
    getCodexErrorDetail({ message: '{"error":{"message":"inner boom"}}' }),
    "inner boom",
  );
  assert.equal(
    getCodexErrorDetail({ error: { message: "nested failure" } }),
    "nested failure",
  );
  assert.equal(getCodexErrorDetail({}), null);
  assert.equal(getCodexErrorDetail("not an object"), null);
});

test("chunks text input by the given chunk size", () => {
  assert.deepEqual(chunkTextInput("abcdefgh", 3), ["abc", "def", "gh"]);
  assert.deepEqual(chunkTextInput("short"), ["short"]);
  assert.deepEqual(chunkTextInput(null), [""]);
});

test("finds the latest user message in a conversation", () => {
  const first = makeTextMessage("user", "one");
  const latest = makeTextMessage("user", "two");
  const messages = [first, makeTextMessage("assistant", "reply"), latest];
  assert.equal(getLatestUserMessage(messages), latest);
  assert.equal(
    getLatestUserMessage([makeTextMessage("assistant", "hi")]),
    null,
  );
  assert.equal(getLatestUserMessage([]), null);
});

test("serializes text, tool, and file parts with an uppercased role prefix", () => {
  assert.equal(
    serializeCodexMessage({
      parts: [
        { text: "  Hello  ", type: "text" },
        { text: "   ", type: "text" },
      ],
      role: "user",
    }),
    "USER:\nHello",
  );
  assert.equal(
    serializeCodexMessage({
      parts: [{ input: { cmd: "ls" }, output: "ok", type: "tool-bash" }],
      role: "assistant",
    }),
    'ASSISTANT:\n[Tool bash]\ninput:\n{\n  "cmd": "ls"\n}\noutput:\nok',
  );
  assert.equal(
    serializeCodexMessage({
      parts: [{ filename: "pic.png", mediaType: "image/png", type: "file" }],
      role: "user",
    }),
    "USER:\n[Attached image: pic.png (image/png)]",
  );
  assert.equal(serializeCodexMessage({ parts: [], role: "user" }), "");
  assert.equal(serializeCodexMessage(null), "");
});

test("builds a conversation prompt with system prompt, project, and transcript", () => {
  const prompt = buildCodexConversationPrompt({
    messages: [makeTextMessage("user", "Fix the bug")],
    projectPath: "/proj",
    systemPrompt: "SYS PROMPT",
  });
  assert.ok(prompt.startsWith("SYS PROMPT"));
  assert.ok(prompt.includes("Active project: /proj"));
  assert.ok(prompt.includes("Conversation transcript:\n\nUSER:\nFix the bug"));
  assert.ok(
    prompt.endsWith(
      "Continue the conversation naturally and complete the user's latest request.",
    ),
  );
});

test("bounds the conversation prompt length when maxChars is set", () => {
  const prompt = buildCodexConversationPrompt({
    maxChars: 200,
    messages: [
      makeTextMessage("user", "x".repeat(5000)),
      makeTextMessage("assistant", "y".repeat(5000)),
    ],
    projectPath: "/proj",
    systemPrompt: "SYS",
  });
  assert.ok(prompt.length <= 200);
});

test("combines the latest user message with references and attachments", () => {
  const messages = [
    makeTextMessage("user", "One"),
    makeTextMessage("assistant", "Reply"),
    makeTextMessage("user", "Two"),
  ];
  assert.equal(getLatestUserPrompt(messages), "USER:\nTwo");
  assert.equal(
    getLatestUserPrompt(messages, "ATTACHMENTS", "REFERENCES"),
    "USER:\nTwo\n\nREFERENCES\n\nATTACHMENTS",
  );
  assert.equal(
    getLatestUserPrompt([], "ATTACHMENTS", "REFERENCES"),
    "REFERENCES\n\nATTACHMENTS",
  );
});
