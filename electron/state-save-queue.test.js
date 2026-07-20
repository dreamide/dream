import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
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
