import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  closePersistedStateDatabase,
  loadPersistedCatalog,
  loadPersistedState,
} from "./persisted-state.js";
import {
  createStateSaveQueue,
  mergeChatMessageSaves,
} from "./state-save-queue.js";

const createProject = (id, lastUsedAt) => ({
  browserUrl: "",
  id,
  icon: null,
  lastUsedAt,
  metadata: {},
  model: "",
  modelSpeed: "standard",
  name: id,
  path: path.join("C:\\projects", id),
  provider: "openai",
  reasoningEffort: null,
  runCommand: "pnpm dev",
  ui: {
    activeChatId: null,
    chatColumnWidths: {},
    chatHistoryPanelOpen: false,
    multiChat: false,
    openChatIds: [],
    panelSizes: {
      chatHistoryPanelWidth: 400,
      leftSidebarWidth: 240,
      rightPanelWidth: 520,
      terminalHeight: 260,
    },
    rightPanelOpen: true,
    rightPanelView: "changes",
    savedPrompts: [],
  },
  worktree: null,
});

test("state save queue preserves the latest active-project update", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-queue-test-"));
  const databasePath = path.join(directory, "state.db");
  const queue = createStateSaveQueue({ databasePath });
  const firstLastUsedAt = "2026-07-19T12:00:00.000Z";
  const secondLastUsedAt = "2026-07-19T12:02:00.000Z";

  try {
    const fullSave = queue.save({
      activeBrowserTabIdByProject: {},
      activeProjectId: "project-one",
      browserTabsByProject: {},
      chats: [],
      chatSort: "recent",
      closedProjects: [],
      messagesByChatId: {},
      projects: [
        createProject("project-one", firstLastUsedAt),
        createProject("project-two", firstLastUsedAt),
      ],
      settings: {},
    });
    const firstSelection = queue.saveActiveProject({
      activeProjectId: "project-two",
      lastUsedAt: firstLastUsedAt,
    });
    const latestSelection = queue.saveActiveProject({
      activeProjectId: "project-two",
      lastUsedAt: secondLastUsedAt,
    });

    await Promise.all([fullSave, firstSelection, latestSelection]);
    await queue.flushAndClose();

    const updated = loadPersistedState({ databasePath });
    assert.equal(updated.activeProjectId, "project-two");
    assert.equal(
      updated.workspaceProjects.find(
        (entry) => entry.projectId === "project-two",
      )?.lastUsedAt,
      secondLastUsedAt,
    );
  } finally {
    await queue.flushAndClose();
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("state save queue lands catalog changes before the transcript, and coalesces it", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-queue-test-"));
  const databasePath = path.join(directory, "state.db");
  const queue = createStateSaveQueue({ databasePath });
  const timestamp = "2026-07-19T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  const chat = {
    agentMode: "build",
    branchedFrom: null,
    createdAt: timestamp,
    deletedAt: null,
    id: "chat-one",
    messageCount: 1,
    model: "gpt-5.6",
    modelSpeed: "standard",
    permissionMode: "full-access",
    projectId: project.id,
    provider: "openai",
    reasoningEffort: null,
    remoteConversationId: null,
    remoteConversationModel: null,
    remoteConversationModelSpeed: null,
    remoteConversationProjectPath: null,
    sparklesPalette: "dream",
    title: "Chat",
    updatedAt: timestamp,
  };

  try {
    const metadataSave = queue.save({
      activeBrowserTabIdByProject: {},
      activeProjectId: project.id,
      browserTabsByProject: {},
      chats: [chat],
      chatSort: "recent",
      closedProjects: [],
      messagesByChatId: {},
      projects: [project],
      settings: {},
    });
    // The chat reaches the catalog first; its transcript after.
    const catalogChanges = queue.applyCatalogChanges({
      chats: [chat],
      projects: [project],
    });
    const firstMessages = queue.saveChatMessages({
      chatId: chat.id,
      messages: [{ id: "message-one", parts: [], role: "user" }],
    });
    const latestMessages = queue.saveChatMessages({
      chatId: chat.id,
      messages: [
        { id: "message-one", parts: [], role: "user" },
        { id: "message-two", parts: [], role: "assistant" },
      ],
    });

    const results = await Promise.all([
      metadataSave,
      catalogChanges,
      firstMessages,
      latestMessages,
    ]);
    await queue.flushAndClose();

    assert.deepEqual(results[1].chatIds, [chat.id]);
    const catalog = loadPersistedCatalog({ databasePath });
    assert.equal(catalog.chats[0]?.messageCount, 2);
  } finally {
    await queue.flushAndClose();
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("queued transcript saves of one chat become one save", () => {
  const user = { id: "u1", parts: [], role: "user" };
  const early = { id: "a1", parts: [], role: "assistant" };
  const late = { id: "a1", parts: [{ text: "Done", type: "text" }] };
  const whole = { chatId: "c1", messages: [user, early] };

  // A later save of the tail keeps the queued messages before it.
  assert.deepEqual(
    mergeChatMessageSaves(whole, {
      chatId: "c1",
      fromIndex: 1,
      messages: [late],
    }),
    { chatId: "c1", fromIndex: 0, messages: [user, late] },
  );
  // Two saves of the same tail: the later one.
  assert.deepEqual(
    mergeChatMessageSaves(
      { chatId: "c1", fromIndex: 1, messages: [early] },
      { chatId: "c1", fromIndex: 1, messages: [late] },
    ),
    { chatId: "c1", fromIndex: 1, messages: [late] },
  );
  // A later whole transcript replaces a queued tail.
  assert.deepEqual(
    mergeChatMessageSaves(
      { chatId: "c1", fromIndex: 1, messages: [early] },
      whole,
    ),
    whole,
  );
  // Not one save: a gap between them, or another chat.
  assert.equal(
    mergeChatMessageSaves(whole, {
      chatId: "c1",
      fromIndex: 3,
      messages: [late],
    }),
    null,
  );
  assert.equal(
    mergeChatMessageSaves(whole, { chatId: "c2", messages: [user] }),
    null,
  );
});

test("a workspace load waits for the changes queued before it, off the main thread", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-queue-"));
  const databasePath = path.join(directory, "state.db");
  const queue = createStateSaveQueue({ databasePath });

  try {
    const saved = queue.saveWorkspaceChanges({
      config: { chatSort: "titleAsc" },
      upsertRows: [
        {
          hostId: "local",
          lastUsedAt: null,
          projectId: "p1",
          snapshot: { id: "p1", path: "/work/p1" },
          sortOrder: 0,
          status: "open",
          ui: {},
        },
      ],
    });
    // Not awaited: the load is queued behind it and must see it.
    const loaded = await queue.loadWorkspace();

    assert.equal(await saved, true);
    assert.equal(loaded.chatSort, "titleAsc");
    assert.deepEqual(
      loaded.workspaceProjects.map((row) => row.projectId),
      ["p1"],
    );
  } finally {
    await queue.flushAndClose();
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});
