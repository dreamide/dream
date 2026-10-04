import { expect, test } from "vitest";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { buildChatSearchRows } from "./chat-search";

const project = (id: string) => ({ id, name: id }) as ProjectConfig;
const chat = (id: string, title: string, updatedAt: string, projectId = "p") =>
  ({ createdAt: updatedAt, id, projectId, title, updatedAt }) as ChatConfig;
const result = (chatId: string, matchCount = 1) => ({
  chatId,
  matchCount,
  messageId: "m1",
  role: "user",
  snippet: { after: " after", before: "before ", match: "budget" },
});

test("merges title and transcript matches, newest chat first", () => {
  const rows = buildChatSearchRows({
    chats: [
      chat("title", "Retry budget", "2026-01-01T00:00:00.000Z"),
      chat("transcript", "Flaky deploys", "2026-03-01T00:00:00.000Z"),
      chat("both", "Budget review", "2026-02-01T00:00:00.000Z"),
      chat("neither", "Unrelated", "2026-04-01T00:00:00.000Z"),
    ],
    projects: [project("p")],
    query: " Budget ",
    transcriptResults: [result("transcript", 3), result("both")],
  });

  expect(
    rows.map((row) => [row.chat.id, row.snippet !== null, row.moreMatches]),
  ).toEqual([
    ["transcript", true, 2],
    ["both", true, 0],
    ["title", false, 0],
  ]);
});

test("drops results for chats and projects the store does not know", () => {
  const rows = buildChatSearchRows({
    chats: [chat("orphan", "Budget", "2026-01-01T00:00:00.000Z", "gone")],
    projects: [project("p")],
    query: "budget",
    transcriptResults: [result("unknown"), result("orphan")],
  });

  expect(rows).toEqual([]);
});

test("an empty query lists nothing", () => {
  expect(
    buildChatSearchRows({
      chats: [chat("c", "Anything", "2026-01-01T00:00:00.000Z")],
      projects: [project("p")],
      query: "  ",
      transcriptResults: [],
    }),
  ).toEqual([]);
});
