import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import {
  areProjectListsEqualExceptLastUsedAt,
  areProjectsEqualExceptLastUsedAt,
  emptyState,
  ensureActiveChatForProject,
  ensureActiveProject,
  mergePersistedState,
  renderUserMessageText,
} from "./ide-state";

const project = {
  id: "project-one",
  lastUsedAt: "2026-07-19T12:00:00.000Z",
  name: "Project One",
  path: "C:\\projects\\project-one",
  ui: {},
} as ProjectConfig;

test("project comparison ignores recency-only updates", () => {
  const touchedProject = {
    ...project,
    lastUsedAt: "2026-07-19T12:01:00.000Z",
  };

  assert.equal(areProjectsEqualExceptLastUsedAt(project, touchedProject), true);
  assert.equal(
    areProjectListsEqualExceptLastUsedAt([project], [touchedProject]),
    true,
  );
});

test("project comparison keeps meaningful workspace changes", () => {
  assert.equal(
    areProjectsEqualExceptLastUsedAt(project, {
      ...project,
      name: "Renamed Project",
    }),
    false,
  );
});

const createPersistedProject = (
  overrides: Partial<ProjectConfig> = {},
): ProjectConfig =>
  ({
    id: "project-one",
    name: "Project One",
    path: "/home/user/project-one",
    ui: {},
    ...overrides,
  }) as ProjectConfig;

const createPersistedChat = (overrides: Partial<ChatConfig> = {}): ChatConfig =>
  ({
    agentMode: "build",
    createdAt: "2026-07-19T12:00:00.000Z",
    deletedAt: null,
    id: "chat-one",
    model: "gpt-5",
    permissionMode: "full-access",
    projectId: "project-one",
    provider: "openai",
    title: "First chat",
    updatedAt: "2026-07-19T12:00:00.000Z",
    ...overrides,
  }) as ChatConfig;

const createUserMessage = (parts: UIMessage["parts"]): UIMessage =>
  ({ id: "message-one", parts, role: "user" }) as UIMessage;

test("mergePersistedState returns the empty state for missing input", () => {
  assert.deepEqual(mergePersistedState(null), emptyState);
  assert.deepEqual(mergePersistedState(undefined), emptyState);
});

test("mergePersistedState merges persisted projects and chats into defaults", () => {
  const message = createUserMessage([{ text: "hello", type: "text" }]);
  const merged = mergePersistedState({
    activeProjectId: "project-one",
    chats: [createPersistedChat()],
    messagesByChatId: { "chat-one": [message] },
    projects: [createPersistedProject()],
    settings: { archiveChatsAfterDays: 14 } as never,
  });

  assert.equal(merged.activeProjectId, "project-one");
  assert.equal(merged.projects.length, 1);
  assert.equal(merged.chats.length, 1);
  assert.equal(merged.chats[0].title, "First chat");
  assert.equal(merged.chats[0].permissionMode, "full-access");
  assert.deepEqual(merged.messagesByChatId["chat-one"], [message]);
  assert.equal(merged.projects[0].ui.activeChatId, "chat-one");
  assert.deepEqual(merged.projects[0].ui.openChatIds, ["chat-one"]);
  assert.equal(merged.projects[0].ui.changesDiffWordWrap, false);
  assert.equal(merged.projects[0].ui.fileEditorWordWrap, false);
  assert.equal(merged.settings.archiveChatsAfterDays, 14);
  assert.equal(merged.settings.locale, "en");
  assert.equal(merged.chatSort, "recent");
});

test("mergePersistedState preserves the project file editor word-wrap preference", () => {
  const merged = mergePersistedState({
    projects: [
      createPersistedProject({
        ui: { fileEditorWordWrap: true } as ProjectConfig["ui"],
      }),
    ],
  });

  assert.equal(merged.projects[0].ui.fileEditorWordWrap, true);
});

test("mergePersistedState preserves the project changes diff word-wrap preference", () => {
  const merged = mergePersistedState({
    projects: [
      createPersistedProject({
        ui: { changesDiffWordWrap: true } as ProjectConfig["ui"],
      }),
    ],
  });

  assert.equal(merged.projects[0].ui.changesDiffWordWrap, true);
});

test("mergePersistedState normalizes tasks and drops invalid ones", () => {
  const merged = mergePersistedState({
    projects: [
      createPersistedProject({
        ui: {
          tasks: [
            {
              branch: "task/valid",
              createdAt: "2026-08-15T12:00:00.000Z",
              description: "Details",
              id: "task-one",
              runs: [
                {
                  chatId: "chat-1",
                  finishedAt: "2026-08-15T13:00:00.000Z",
                  id: "run-1",
                  output: "The plan",
                  startedAt: "2026-08-15T12:00:00.000Z",
                  step: "plan",
                },
                { id: "run-2", step: "bogus" },
                { id: "run-1", step: "build" },
              ],
              step: "plan",
              title: "Valid",
              updatedAt: "2026-08-15T12:00:00.000Z",
            },
            { id: "task-two", step: "bogus", title: "Bad step", runs: 42 },
            { id: "", title: "No id" },
            { id: "task-one", title: "Duplicate" },
          ],
        } as unknown as ProjectConfig["ui"],
      }),
    ],
  });

  const tasks = merged.projects[0].ui.tasks;
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].id, "task-one");
  assert.equal(tasks[0].step, "plan");
  assert.equal(tasks[0].branch, "task/valid");
  assert.equal(tasks[0].runs.length, 1);
  assert.equal(tasks[0].runs[0].output, "The plan");
  assert.equal(tasks[0].runs[0].feedback, null);
  assert.equal(tasks[0].completion, null);
  assert.equal(tasks[1].id, "task-two");
  assert.equal(tasks[1].step, "backlog");
  assert.deepEqual(tasks[1].runs, []);
  assert.equal(tasks[1].worktreeProjectId, null);
});

test("mergePersistedState reads tasks saved under the old pipeline keys", () => {
  const timestamp = "2026-08-15T12:00:00.000Z";
  const merged = mergePersistedState({
    projects: [
      createPersistedProject({
        id: "project-one",
        ui: {
          pipelineConfig: { build: { autoAdvance: false } },
          pipelineTasks: [
            {
              createdAt: timestamp,
              description: "",
              id: "task-one",
              runs: [],
              step: "backlog",
              title: "Ship it",
              updatedAt: timestamp,
            },
          ],
        } as unknown as ProjectConfig["ui"],
      }),
    ],
  });

  const ui = merged.projects[0].ui;
  assert.deepEqual(
    ui.tasks.map((task) => task.id),
    ["task-one"],
  );
  assert.equal("pipelineTasks" in ui, false);
  // Step settings are app-wide now; the project's copy seeds them once.
  assert.equal("taskConfig" in ui, false);
  assert.equal(merged.taskConfig.build.autoAdvance, false);
});

test("mergePersistedState migrates legacy kanban cards into tasks", () => {
  const timestamp = "2026-08-15T12:00:00.000Z";
  const legacyCard = (id: string, column: string, chatId: string | null) => ({
    chatId,
    column,
    createdAt: timestamp,
    description: "",
    id,
    title: id,
    updatedAt: timestamp,
  });
  const merged = mergePersistedState({
    projects: [
      createPersistedProject({
        ui: {
          kanbanCards: [
            legacyCard("backlog", "backlog", null),
            legacyCard("ready", "ready", "chat-ignored"),
            legacyCard("progress", "inProgress", "chat-progress"),
            legacyCard("review", "review", "chat-review"),
            legacyCard("done", "done", "chat-done"),
          ],
        } as unknown as ProjectConfig["ui"],
      }),
    ],
  });

  const tasks = merged.projects[0].ui.tasks;
  assert.deepEqual(
    tasks.map((task) => task.step),
    ["backlog", "backlog", "build", "review", "merge"],
  );
  assert.deepEqual(tasks[1].runs, []);
  assert.equal(tasks[2].runs[0].chatId, "chat-progress");
  assert.equal(tasks[2].runs[0].step, "build");
  assert.equal(tasks[2].runs[0].finishedAt, null);
  assert.equal(tasks[3].runs[0].finishedAt, timestamp);
  assert.equal(tasks[4].completion?.kind, "legacy");
  assert.ok(tasks.every((task) => task.worktreeProjectId === null));
});

test("mergePersistedState seeds the app-wide step config from legacy project configs", () => {
  const legacyProject = (id: string, ui: Record<string, unknown>) =>
    createPersistedProject({ id, ui: ui as unknown as ProjectConfig["ui"] });
  const untouched = legacyProject("project-untouched", { taskConfig: {} });
  const customized = legacyProject("project-customized", {
    taskConfig: { plan: { prompt: "Customized plan" } },
  });
  // Saved when the workspace was still called the pipeline.
  const older = legacyProject("project-older", {
    pipelineConfig: { plan: { prompt: "Older plan" } },
  });

  // The first project that changed anything wins...
  assert.equal(
    mergePersistedState({ projects: [untouched, customized, older] }).taskConfig
      .plan.prompt,
    "Customized plan",
  );
  // ...unless the active project has customizations of its own.
  assert.equal(
    mergePersistedState({
      activeProjectId: "project-older",
      projects: [untouched, customized, older],
    }).taskConfig.plan.prompt,
    "Older plan",
  );
  // Nothing customized anywhere: built-in defaults.
  assert.equal(
    mergePersistedState({ projects: [untouched] }).taskConfig.plan.prompt,
    null,
  );
  // Once an app-wide config is saved, project leftovers are ignored.
  assert.equal(
    mergePersistedState({
      projects: [customized],
      taskConfig: { plan: { prompt: "Saved app-wide" } },
    } as unknown as Parameters<typeof mergePersistedState>[0]).taskConfig.plan
      .prompt,
    "Saved app-wide",
  );
});

test("mergePersistedState fills task step config gaps from defaults", () => {
  const merged = mergePersistedState({
    taskConfig: {
      build: {
        autoAdvance: false,
        model: {
          model: "opus",
          provider: "anthropic",
          reasoningEffort: "high",
        },
        prompt: "Custom build prompt",
      },
      plan: { agentMode: "bogus", model: { model: "" }, prompt: "  " },
    },
  } as unknown as Parameters<typeof mergePersistedState>[0]);

  const config = merged.taskConfig;
  assert.equal(config.build.autoAdvance, false);
  assert.equal(config.build.agentMode, "build");
  assert.equal(config.build.prompt, "Custom build prompt");
  assert.equal(config.build.model?.model, "opus");
  assert.equal(config.build.model?.modelSpeed, "standard");
  assert.equal(config.plan.agentMode, "plan");
  assert.equal(config.plan.model, null);
  assert.equal(config.plan.prompt, null);
  assert.equal(config.review.permissionMode, "standard");
  assert.equal(config.merge.autoAdvance, false);
});

const createLegacyWorkspaceViewProjects = () => [
  createPersistedProject({
    id: "project-pipeline",
    ui: { workspaceView: "pipeline" } as unknown as ProjectConfig["ui"],
  }),
  createPersistedProject({
    id: "project-kanban",
    ui: { workspaceView: "kanban" } as unknown as ProjectConfig["ui"],
  }),
  createPersistedProject({
    id: "project-code",
    ui: { workspaceView: "code" } as unknown as ProjectConfig["ui"],
  }),
  createPersistedProject({
    id: "project-missing",
    ui: {} as ProjectConfig["ui"],
  }),
];

test("mergePersistedState seeds the app view from the active project's legacy workspace view", () => {
  const appViewFor = (activeProjectId: string | null) =>
    mergePersistedState({
      activeProjectId,
      projects: createLegacyWorkspaceViewProjects(),
    }).appView;

  // "pipeline" and, before it, "kanban" are the Tasks workspace's old names.
  assert.equal(appViewFor("project-pipeline"), "tasks");
  assert.equal(appViewFor("project-kanban"), "tasks");
  assert.equal(appViewFor("project-code"), "code");
  assert.equal(appViewFor("project-missing"), "code");
  // Only the active project's choice carries over.
  assert.equal(appViewFor(null), "code");

  const merged = mergePersistedState({
    activeProjectId: "project-pipeline",
    projects: createLegacyWorkspaceViewProjects(),
  });
  assert.equal("workspaceView" in merged.projects[0].ui, false);
});

test("mergePersistedState prefers a saved app view over the legacy workspace view", () => {
  const merged = mergePersistedState({
    activeProjectId: "project-pipeline",
    appView: "code",
    projects: createLegacyWorkspaceViewProjects(),
  });

  assert.equal(merged.appView, "code");
});

test("mergePersistedState validates the app view and Tasks project filter", () => {
  const projects = [createPersistedProject({ id: "project-one" })];
  const closedProjects = [createPersistedProject({ id: "project-closed" })];

  const saved = mergePersistedState({
    appView: "tasks",
    tasksProjectId: "project-one",
    projects,
  });
  assert.equal(saved.appView, "tasks");
  // The view was briefly saved under the workspace's old name.
  assert.equal(
    mergePersistedState({
      appView: "pipeline",
    } as unknown as Parameters<typeof mergePersistedState>[0]).appView,
    "tasks",
  );
  assert.equal(saved.tasksProjectId, "project-one");

  // Only an open project can be filtered to; anything else shows everything.
  for (const tasksProjectId of ["project-closed", "project-gone", 42]) {
    const merged = mergePersistedState({
      closedProjects,
      tasksProjectId,
      projects,
    } as unknown as Parameters<typeof mergePersistedState>[0]);
    assert.equal(merged.tasksProjectId, null);
  }

  const invalid = mergePersistedState({
    appView: "bogus",
  } as unknown as Parameters<typeof mergePersistedState>[0]);
  assert.equal(invalid.appView, "code");

  const missing = mergePersistedState({});
  assert.equal(missing.appView, "code");
  assert.equal(missing.tasksProjectId, null);
});

test("mergePersistedState preserves stash items and drops invalid ones", () => {
  const merged = mergePersistedState({
    projects: [
      createPersistedProject({
        ui: {
          stashItems: [
            {
              agentMode: "plan",
              createdAt: "2026-08-15T12:00:00.000Z",
              id: "stash-one",
              model: "gpt-5",
              modelSpeed: "fast",
              permissionMode: "standard",
              provider: "openai",
              reasoningEffort: "high",
              references: [
                {
                  kind: "file",
                  name: "app.tsx",
                  parentPath: "src",
                  path: "src/app.tsx",
                },
              ],
              text: "Ship stash",
              updatedAt: "2026-08-15T12:00:00.000Z",
            },
            { id: "", text: "missing id" },
            { id: "stash-one", text: "duplicate" },
          ],
        } as ProjectConfig["ui"],
      }),
    ],
  });

  assert.deepEqual(merged.projects[0].ui.stashItems, [
    {
      agentMode: "plan",
      createdAt: "2026-08-15T12:00:00.000Z",
      id: "stash-one",
      model: "gpt-5",
      modelSpeed: "fast",
      permissionMode: "standard",
      provider: "openai",
      reasoningEffort: "high",
      references: [
        {
          kind: "file",
          name: "app.tsx",
          parentPath: "src",
          path: "src/app.tsx",
        },
      ],
      text: "Ship stash",
      updatedAt: "2026-08-15T12:00:00.000Z",
    },
  ]);
});

test("mergePersistedState creates a default chat for projects without chats", () => {
  const merged = mergePersistedState({
    chats: [],
    projects: [createPersistedProject()],
    settings: { autoAcceptPermissions: false } as never,
  });

  assert.equal(merged.chats.length, 1);
  assert.equal(merged.chats[0].projectId, "project-one");
  assert.equal(merged.chats[0].title, "New chat");
  assert.equal(merged.chats[0].permissionMode, "standard");
  assert.deepEqual(merged.messagesByChatId[merged.chats[0].id], []);
  assert.equal(merged.projects[0].ui.activeChatId, merged.chats[0].id);
});

test("mergePersistedState preserves branch lineage without requiring the parent chat", () => {
  const merged = mergePersistedState({
    chats: [
      createPersistedChat({
        branchedFrom: {
          chatId: "deleted-parent",
          messageId: "message-parent",
        },
      }),
    ],
    messagesByChatId: {
      "chat-one": [createUserMessage([{ text: "branch", type: "text" }])],
    },
    projects: [createPersistedProject()],
  });

  assert.deepEqual(merged.chats[0].branchedFrom, {
    chatId: "deleted-parent",
    messageId: "message-parent",
  });
});

test("mergePersistedState migrates legacy thread-based state", () => {
  const message = createUserMessage([{ text: "legacy", type: "text" }]);
  const merged = mergePersistedState({
    activeChatIdByProject: { "project-one": "chat-two" },
    messagesByChatId: { "project-one": [message] },
    projects: [createPersistedProject()],
    threads: [
      createPersistedChat(),
      createPersistedChat({ id: "chat-two", title: "Second chat" }),
      createPersistedChat({ id: "chat-orphan", projectId: "missing-project" }),
    ],
    threadSort: "titleAsc",
  } as never);

  assert.deepEqual(
    merged.chats.map((chat) => chat.id),
    ["chat-one", "chat-two"],
  );
  assert.equal(merged.projects[0].ui.activeChatId, "chat-two");
  assert.deepEqual(merged.messagesByChatId["chat-one"], [message]);
  assert.deepEqual(merged.messagesByChatId["chat-two"], [message]);
  assert.equal(merged.chatSort, "titleAsc");
});

test("mergePersistedState drops closed projects that duplicate open ones", () => {
  const merged = mergePersistedState({
    closedProjects: [
      createPersistedProject({
        id: "project-closed",
        path: "/home/user/project-one/",
      }),
      createPersistedProject({
        id: "project-two",
        name: "Two",
        path: "/home/user/two",
      }),
    ],
    projects: [createPersistedProject()],
  });

  assert.deepEqual(
    merged.closedProjects.map((closedProject) => closedProject.id),
    ["project-two"],
  );
});

test("ensureActiveProject keeps a valid selection and falls back to the first project", () => {
  const projects = [
    createPersistedProject(),
    createPersistedProject({ id: "project-two" }),
  ];

  assert.equal(ensureActiveProject(projects, "project-two"), "project-two");
  assert.equal(ensureActiveProject(projects, "project-missing"), "project-one");
  assert.equal(ensureActiveProject(projects, null), "project-one");
  assert.equal(ensureActiveProject([], "project-one"), null);
});

test("ensureActiveChatForProject ignores deleted chats and other projects", () => {
  const chats = [
    createPersistedChat({
      deletedAt: "2026-07-19T12:30:00.000Z",
      id: "chat-deleted",
    }),
    createPersistedChat({ id: "chat-live" }),
    createPersistedChat({ id: "chat-other", projectId: "project-two" }),
  ];

  assert.equal(
    ensureActiveChatForProject(chats, "project-one", "chat-live"),
    "chat-live",
  );
  assert.equal(
    ensureActiveChatForProject(chats, "project-one", "chat-deleted"),
    "chat-live",
  );
  assert.equal(
    ensureActiveChatForProject(chats, "project-one", "chat-other"),
    "chat-live",
  );
  assert.equal(ensureActiveChatForProject(chats, "project-three", null), null);
});

test("renderUserMessageText joins text sections and labels attachments", () => {
  const message = createUserMessage([
    { text: "  First paragraph  ", type: "text" },
    { text: "   ", type: "text" },
    {
      filename: "screenshot.png",
      mediaType: "image/png",
      type: "file",
      url: "file:///tmp/screenshot.png",
    },
    { mediaType: "application/pdf", type: "file", url: "file:///tmp/doc.pdf" },
    { state: "done", text: "thinking", type: "reasoning" },
  ] as UIMessage["parts"]);

  assert.equal(
    renderUserMessageText(message),
    "First paragraph\n\n[Attached file: screenshot.png]\n\n[Attached file: application/pdf]",
  );
  assert.equal(renderUserMessageText(createUserMessage([])), "");
});
