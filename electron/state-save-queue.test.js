import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  closePersistedStateDatabase,
  loadPersistedState,
} from "./persisted-state.js";
import { createStateSaveQueue } from "./state-save-queue.js";

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
      updated.projects.find((project) => project.id === "project-two")
        ?.lastUsedAt,
      secondLastUsedAt,
    );
  } finally {
    await queue.flushAndClose();
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("state save queue writes and coalesces one dirty transcript", async () => {
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

    await Promise.all([metadataSave, firstMessages, latestMessages]);
    await queue.flushAndClose();

    const updated = loadPersistedState({ databasePath });
    assert.equal(updated.chats[0]?.messageCount, 2);
  } finally {
    await queue.flushAndClose();
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});
