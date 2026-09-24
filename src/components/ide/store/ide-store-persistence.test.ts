import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createChatConfig,
  createProjectConfig,
  createTask,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig, Task } from "@/types/ide";
import { createPersistedIdeState } from "./ide-store-persistence";

const persist = (
  project: ProjectConfig,
  chats: ChatConfig[],
  tasks: Task[] = [],
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
    tasks,
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

test("tasks are saved app-wide, independent of any project", () => {
  const project = createProjectConfig("/workspace/source", DEFAULT_SETTINGS);
  const tasks = [
    createTask({ prompt: "Address the review comments", title: "Review" }),
    createTask({ prompt: "Run the tests", title: "Test" }),
  ];

  const persisted = persist(project, [], tasks);

  assert.deepEqual(persisted.tasks, tasks);
});
