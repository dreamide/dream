import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createChatConfig,
  createProjectConfig,
  createSavedPrompt,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig, SavedPrompt } from "@/types/ide";
import { createPersistedIdeState } from "./ide-store-persistence";

const persist = (
  project: ProjectConfig,
  chats: ChatConfig[],
  savedPrompts: SavedPrompt[] = [],
) =>
  createPersistedIdeState({
    activeBrowserTabIdByProject: {},
    activeProjectId: project.id,
    appView: "code",
    browserTabsByProject: {},
    chats,
    chatSort: "recent",
    closedProjects: [],
    messagesByChatId: {},
    projects: [project],
    settings: DEFAULT_SETTINGS,
    savedPrompts,
  });

test("empty draft chats are dropped unless they are the open chat", () => {
  const baseProject = createProjectConfig(
    "/workspace/source",
    DEFAULT_SETTINGS,
  );
  const draft = createChatConfig(baseProject, { title: "Draft" });
  const openChat = createChatConfig(baseProject, { title: "Open" });
  const project = {
    ...baseProject,
    ui: { ...baseProject.ui, activeChatId: openChat.id },
  };

  const persisted = persist(project, [draft, openChat]);

  assert.deepEqual(
    persisted.chats.map((chat) => chat.id),
    [openChat.id],
  );
});

test("saved prompts are stored app-wide, independent of any project", () => {
  const project = createProjectConfig("/workspace/source", DEFAULT_SETTINGS);
  const savedPrompts = [
    createSavedPrompt({
      prompt: "Address the review comments",
      name: "Review",
    }),
    createSavedPrompt({ prompt: "Run the tests", name: "Test" }),
  ];

  const persisted = persist(project, [], savedPrompts);

  assert.deepEqual(persisted.savedPrompts, savedPrompts);
});
