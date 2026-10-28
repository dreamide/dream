import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { beforeEach, test, vi } from "vitest";
import { apiClient } from "@/lib/api-client";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import {
  loadPersistedChatMessages,
  savePersistedChatMessages,
} from "./ide-store-persistence";
import type { IdeState } from "./ide-store-types";
import { createTranscriptCache } from "./transcript-cache";

vi.mock("./ide-store-persistence", () => ({
  loadPersistedChatMessages: vi.fn(),
  savePersistedChatMessages: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({
  apiClient: { catalogTranscriptPage: vi.fn() },
}));
const messages: UIMessage[] = Array.from({ length: 100 }, (_, i) => ({
  id: `m-${i}`,
  role: "user",
  parts: [{ type: "text", text: `Message ${i}` }],
}));
beforeEach(() => {
  vi.clearAllMocks();
});

function setup() {
  const project = createProjectConfig("/work", DEFAULT_SETTINGS);
  const chat = createChatConfig(project);
  let state = {
    projects: [project],
    chats: [chat],
    messagesByChatId: {},
    transcriptPageByChatId: {},
    streamingChatIds: {},
    awaitingAnswerChatIds: {},
    pendingChatSubmitByChatId: {},
    persist() {},
  } as unknown as IdeState;
  const set = (next: Partial<IdeState>) => {
    const previous = state;
    state = { ...state, ...next };
    cache.observe(state, previous);
  };
  const cache = createTranscriptCache(() => state, set);
  state = {
    ...state,
    ...cache.actions,
    setMessagesForChat: (id, value) =>
      set({ messagesByChatId: { ...state.messagesByChatId, [id]: value } }),
  };
  vi.mocked(loadPersistedChatMessages).mockResolvedValue(messages);
  vi.mocked(apiClient.catalogTranscriptPage).mockImplementation(
    async ({ before }) => {
      const end = before ? Number(before.slice(2)) : 100;
      const start = Math.max(0, end - 40);
      return {
        messages: messages.slice(start, end),
        startIndex: start,
        total: 100,
        before: start ? `m-${start}` : null,
      };
    },
  );
  return { get: () => state, id: chat.id };
}

test("recent loads deduplicate; earlier pages prepend once; full-history callers load the complete transcript", async () => {
  const { get, id } = setup();
  await Promise.all([
    get().loadRecentMessagesForChat(id),
    get().loadRecentMessagesForChat(id),
  ]);
  assert.equal(vi.mocked(apiClient.catalogTranscriptPage).mock.calls.length, 1);
  assert.deepEqual(get().messagesByChatId[id], messages.slice(60));
  await Promise.all([
    get().loadEarlierMessagesForChat(id),
    get().loadEarlierMessagesForChat(id),
  ]);
  assert.deepEqual(get().messagesByChatId[id], messages.slice(20));
  assert.deepEqual(await get().loadMessagesForChat(id), messages);
  assert.equal(get().transcriptPageByChatId[id].before, null);
});

test("a full-history request racing initial paging cannot receive only the recent window", async () => {
  const { get, id } = setup();
  const recent = get().loadRecentMessagesForChat(id);
  const full = get().loadMessagesForChat(id);
  await recent;
  assert.deepEqual(await full, messages);
});

test("refresh preserves the loaded window and partial saves request a transactional merge", async () => {
  const { get, id } = setup();
  await get().loadRecentMessagesForChat(id);
  await get().loadEarlierMessagesForChat(id);
  await get().applyCatalogTranscript(id);
  assert.deepEqual(get().messagesByChatId[id], messages.slice(20));
  await get().persistMessagesForChat(id);
  assert.deepEqual(vi.mocked(savePersistedChatMessages).mock.calls[0], [
    id,
    messages.slice(20),
    true,
  ]);
});

test("another window's chat is counted from the host's notification, without loading it", async () => {
  // A chat started elsewhere arrives empty: its turn's messages are written
  // on the host afterwards, and this window has not loaded them.
  const { get, id } = setup();
  assert.equal(get().chats[0].messageCount, 0);
  await get().applyCatalogTranscript(id, { messageCount: 2 });
  assert.equal(get().chats[0].messageCount, 2);
  assert.equal(Object.hasOwn(get().messagesByChatId, id), false);
  assert.equal(vi.mocked(apiClient.catalogTranscriptPage).mock.calls.length, 0);
});
