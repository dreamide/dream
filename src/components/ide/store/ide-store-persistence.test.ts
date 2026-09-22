import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import {
  createDefaultTaskConfig,
  TASKS_CHAT_PANEL_DEFAULT_WIDTH_PX,
} from "@/lib/task-defaults";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { createPersistedIdeState } from "./ide-store-persistence";

const persist = (project: ProjectConfig, chats: ChatConfig[]) =>
  createPersistedIdeState({
    activeBrowserTabIdByProject: {},
    activeProjectId: project.id,
    appView: "tasks",
    browserTabsByProject: {},
    chats,
    chatSort: "recent",
    closedProjects: [],
    messagesByChatId: {},
    projects: [project],
    settings: DEFAULT_SETTINGS,
    taskConfig: createDefaultTaskConfig(),
    tasks: [],
    tasksChatPanelWidth: TASKS_CHAT_PANEL_DEFAULT_WIDTH_PX,
    tasksProjectId: null,
  });

test("empty draft chats are dropped, but a task's step chats are kept", () => {
  const project = createProjectConfig("/workspace/source", DEFAULT_SETTINGS);
  const draft = createChatConfig(project, { title: "Draft" });
  // A step chat whose transcript came up empty is still what the task's run
  // points at, and it is never the project's open chat.
  const stepChat = createChatConfig(project, { taskId: "task-one" });

  const persisted = persist(project, [draft, stepChat]);

  assert.deepEqual(
    persisted.chats.map((chat) => chat.id),
    [stepChat.id],
  );
});
