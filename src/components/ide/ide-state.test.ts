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
    branchedFrom: null,
    createdAt: "2026-07-19T12:00:00.000Z",
    deletedAt: null,
    id: "chat-one",
    messageCount: 0,
    model: "gpt-5",
    modelSpeed: "standard",
    permissionMode: "full-access",
    projectId: "project-one",
    provider: "openai",
    reasoningEffort: null,
    remoteConversationId: null,
    remoteConversationModel: null,
    remoteConversationModelSpeed: null,
    remoteConversationProjectPath: null,
    sparklesPalette: "blue",
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

test("mergePersistedState keeps saved prompts and drops invalid ones", () => {
  const merged = mergePersistedState({
    savedPrompts: [
      {
        createdAt: "2026-09-01T12:00:00.000Z",
        id: "prompt-one",
        prompt: "Address the review comments on {{branch}}",
        name: "Address review",
        updatedAt: "2026-09-02T12:00:00.000Z",
      },
      { id: "prompt-two", prompt: "No dates" },
      { id: "", prompt: "No id" },
      { id: "prompt-one", prompt: "Duplicate", name: "Duplicate" },
      // No prompt text.
      { id: "prompt-three", name: "Old" },
    ] as never,
  });

  assert.deepEqual(
    merged.savedPrompts.map((savedPrompt) => savedPrompt.id),
    ["prompt-one", "prompt-two"],
  );
  assert.deepEqual(merged.savedPrompts[0], {
    createdAt: "2026-09-01T12:00:00.000Z",
    id: "prompt-one",
    prompt: "Address the review comments on {{branch}}",
    name: "Address review",
    updatedAt: "2026-09-02T12:00:00.000Z",
  });
  assert.equal(merged.savedPrompts[1].name, "");
  assert.equal(
    merged.savedPrompts[1].updatedAt,
    merged.savedPrompts[1].createdAt,
  );
});

test("mergePersistedState drops pipeline tasks and step settings stored on projects", () => {
  const merged = mergePersistedState({
    projects: [
      createPersistedProject({
        ui: {
          kanbanCards: [{ id: "card-one", title: "Card" }],
          pipelineTasks: [{ id: "task-old", title: "Old" }],
          taskConfig: { plan: { prompt: "Custom" } },
          tasks: [{ id: "task-one", step: "plan", title: "Old" }],
          workspaceView: "pipeline",
        } as unknown as ProjectConfig["ui"],
      }),
    ],
  });

  assert.deepEqual(merged.savedPrompts, []);
  for (const key of [
    "kanbanCards",
    "pipelineTasks",
    "taskConfig",
    "tasks",
    "workspaceView",
  ]) {
    assert.equal(key in merged.projects[0].ui, false, key);
  }
});

test("mergePersistedState reads the retired Tasks workspace as Code", () => {
  for (const appView of ["tasks", "pipeline", "kanban", "bogus", undefined]) {
    assert.equal(
      mergePersistedState({
        appView,
      } as unknown as Parameters<typeof mergePersistedState>[0]).appView,
      "code",
    );
  }
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
        } as unknown as ProjectConfig["ui"],
      }),
    ],
  });

  assert.deepEqual(merged.projects[0].ui.stashItems, [
    {
      createdAt: "2026-08-15T12:00:00.000Z",
      id: "stash-one",
      model: "gpt-5",
      modelSpeed: "fast",
      permissionMode: "ask",
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
  assert.equal(merged.chats[0].permissionMode, "full-access");
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

test("mergePersistedState defaults the new-chat and text generation settings", () => {
  const merged = mergePersistedState({ settings: {} } as never);
  assert.equal(merged.settings.defaultPermissionMode, "full-access");
  // Profiles from before the setting keep the original low effort.
  assert.equal(merged.settings.defaultGitGenerationReasoningEffort, "low");
  assert.equal(merged.settings.defaultGitGenerationModelSpeed, "standard");
});

test("mergePersistedState reads the new-chat and text generation settings", () => {
  const merged = mergePersistedState({
    settings: {
      defaultGitGenerationModelSpeed: "fast",
      // `null` is the explicit "medium" choice and must not become "low".
      defaultGitGenerationReasoningEffort: null,
      defaultPermissionMode: "auto-accept-edits",
    },
  } as never);
  assert.equal(merged.settings.defaultPermissionMode, "auto-accept-edits");
  assert.equal(merged.settings.defaultGitGenerationReasoningEffort, null);
  assert.equal(merged.settings.defaultGitGenerationModelSpeed, "fast");
});

test("mergePersistedState defaults new chats to full access despite the legacy auto-accept setting", () => {
  const merged = mergePersistedState({
    settings: { autoAcceptPermissions: false },
  } as never);
  assert.equal(merged.settings.defaultPermissionMode, "full-access");
});
