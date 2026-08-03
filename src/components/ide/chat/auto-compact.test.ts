import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import {
  AUTO_COMPACT_TRIGGER_RATIO,
  estimateMessages,
  hasAutoCompactionSummary,
  maybeAutoCompactMessages,
} from "@/components/ide/chat/auto-compact";

const createTextMessage = (
  id: string,
  text: string,
  role: UIMessage["role"] = "assistant",
): UIMessage => ({ id, parts: [{ text, type: "text" }], role });

const createConversation = (count: number): UIMessage[] =>
  Array.from({ length: count }, (_, index) =>
    createTextMessage(
      `message-${index}`,
      `Message number ${index} with some content.`,
      index % 2 === 0 ? "user" : "assistant",
    ),
  );

test("estimateMessages sums token estimates across text, tool, and unknown parts", () => {
  const messages = [
    createTextMessage("m1", "a".repeat(40)),
    {
      id: "m2",
      parts: [
        {
          input: "b".repeat(40),
          output: "c".repeat(40),
          errorText: "d".repeat(20),
          type: "tool-Bash",
        },
      ],
      role: "assistant",
    } as unknown as UIMessage,
  ];

  // 40/4 text + 40/4 string input + 40/4 string output + 20/4 error text
  assert.equal(estimateMessages(messages), 10 + 10 + 10 + 5);
  assert.equal(estimateMessages([]), 0);
});

test("does not compact below the trigger ratio", () => {
  const messages = createConversation(10);
  const result = maybeAutoCompactMessages({
    contextWindow: 100_000,
    messages,
    usedTokens: 100_000 * AUTO_COMPACT_TRIGGER_RATIO - 1,
  });

  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
});

test("does not compact short conversations or invalid context windows", () => {
  const shortResult = maybeAutoCompactMessages({
    contextWindow: 100_000,
    messages: createConversation(3),
    usedTokens: 90_000,
  });
  assert.equal(shortResult.compacted, false);

  const invalidWindowResult = maybeAutoCompactMessages({
    contextWindow: 0,
    messages: createConversation(10),
    usedTokens: 90_000,
  });
  assert.equal(invalidWindowResult.compacted, false);
});

test("compacts older messages into a summary and keeps recent ones verbatim", () => {
  const messages = createConversation(6);
  const result = maybeAutoCompactMessages({
    contextWindow: 100_000,
    messages,
    usedTokens: 60_000,
  });

  assert.equal(result.compacted, true);
  if (!result.compacted) {
    return;
  }

  assert.equal(result.messages.length, 5);
  assert.equal(result.compactedCount, 2);

  const summary = result.messages[0];
  assert.equal(summary.role, "assistant");
  assert.match(summary.id, /^auto-compact-/);
  assert.deepEqual(
    { ...(summary.metadata as Record<string, unknown>), compactedAt: null },
    { autoCompacted: true, compactedAt: null, compactedMessageCount: 2 },
  );

  const summaryText = (summary.parts[0] as { text: string }).text;
  assert.match(summaryText, /Auto-compacted context summary\./);
  assert.match(summaryText, /Compacted 2 of 6 earlier messages/);
  assert.match(summaryText, /Message number 0/);

  // The last four messages are kept verbatim (same references).
  assert.deepEqual(result.messages.slice(1), messages.slice(2));
});

test("summarizes tool calls in the compaction summary body", () => {
  const messages = [
    {
      id: "tool-msg",
      parts: [
        {
          input: { command: "ls" },
          output: "file.txt",
          type: "tool-Bash",
        },
      ],
      role: "assistant",
    } as unknown as UIMessage,
    ...createConversation(5),
  ];

  const result = maybeAutoCompactMessages({
    contextWindow: 100_000,
    messages,
    usedTokens: 60_000,
  });

  assert.equal(result.compacted, true);
  if (!result.compacted) {
    return;
  }

  const summaryText = (result.messages[0].parts[0] as { text: string }).text;
  assert.match(summaryText, /\[tool Bash\]/);
  assert.match(summaryText, /input: \{"command":"ls"\}/);
  assert.match(summaryText, /output: file\.txt/);
});

test("refuses to compact past a pending tool approval", () => {
  const messages = createConversation(6);
  messages[1] = {
    id: "approval-msg",
    parts: [
      {
        approval: { id: "approval-1" },
        input: { command: "rm -rf" },
        state: "approval-requested",
        toolCallId: "call-1",
        type: "tool-Bash",
      },
    ],
    role: "assistant",
  } as UIMessage;

  const result = maybeAutoCompactMessages({
    contextWindow: 100_000,
    messages,
    usedTokens: 60_000,
  });

  assert.equal(result.compacted, false);
  assert.equal(result.messages, messages);
});

test("hasAutoCompactionSummary detects the summary metadata flag", () => {
  const plain = createConversation(2);
  assert.equal(hasAutoCompactionSummary(plain), false);

  const withSummary = [
    {
      ...createTextMessage("summary", "Summary text"),
      metadata: { autoCompacted: true },
    } as UIMessage,
    ...plain,
  ];
  assert.equal(hasAutoCompactionSummary(withSummary), true);

  const wrongFlag = [
    {
      ...createTextMessage("summary", "Summary text"),
      metadata: { autoCompacted: "yes" },
    } as UIMessage,
  ];
  assert.equal(hasAutoCompactionSummary(wrongFlag), false);
});

test("compaction output itself registers as containing a summary", () => {
  const result = maybeAutoCompactMessages({
    contextWindow: 100_000,
    messages: createConversation(8),
    usedTokens: 90_000,
  });

  assert.equal(result.compacted, true);
  assert.equal(hasAutoCompactionSummary(result.messages), true);
});
