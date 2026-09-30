import assert from "node:assert/strict";
import { test } from "vitest";
import {
  chatFromRow,
  chatToRow,
  createChatConfig,
  createEmptyPersistedState,
  DEFAULT_SETTINGS,
  decodePersistedState,
  encodePersistedState,
  ensureActiveChatForProject,
  ensureActiveProject,
  projectFromRow,
  projectToRow,
  stateFromConfig,
  stateToConfig,
} from "./persisted-state-codec.js";

const createRawProject = (overrides = {}) => ({
  id: "project-one",
  name: "Project One",
  path: "/home/user/project-one",
  ui: {},
  ...overrides,
});

const createRawChat = (overrides = {}) => ({
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
  sparklesPalette: "aqua",
  title: "First chat",
  updatedAt: "2026-07-19T12:00:00.000Z",
  ...overrides,
});

const userMessage = {
  id: "message-one",
  parts: [{ text: "hi", type: "text" }],
  role: "user",
};

// ── decode ────────────────────────────────────────────────────────────

test("decode returns the empty state for anything that is not a record", () => {
  for (const raw of [null, undefined, "state", 3, []]) {
    assert.deepEqual(decodePersistedState(raw), createEmptyPersistedState());
  }
});

test("decode merges persisted projects and chats into defaults", () => {
  const decoded = decodePersistedState({
    activeProjectId: "project-one",
    chats: [createRawChat()],
    messagesByChatId: { "chat-one": [userMessage] },
    projects: [createRawProject()],
    settings: { archiveChatsAfterDays: 14 },
  });

  assert.equal(decoded.activeProjectId, "project-one");
  assert.equal(decoded.projects.length, 1);
  assert.equal(decoded.chats.length, 1);
  assert.equal(decoded.chats[0].title, "First chat");
  assert.equal(decoded.chats[0].permissionMode, "full-access");
  assert.equal(decoded.chats[0].messageCount, 1);
  assert.deepEqual(decoded.messagesByChatId["chat-one"], [userMessage]);
  assert.equal(decoded.projects[0].ui.activeChatId, "chat-one");
  assert.deepEqual(decoded.projects[0].ui.openChatIds, ["chat-one"]);
  assert.equal(decoded.projects[0].ui.changesDiffWordWrap, false);
  assert.equal(decoded.projects[0].ui.fileEditorWordWrap, false);
  assert.equal(decoded.projects[0].runCommand, "pnpm dev");
  assert.equal(decoded.settings.archiveChatsAfterDays, 14);
  assert.equal(decoded.settings.locale, "en");
  assert.equal(decoded.chatSort, "recent");
});

test("decode keeps every project ui preference", () => {
  const decoded = decodePersistedState({
    projects: [
      createRawProject({
        ui: {
          changesDiffWordWrap: true,
          chatHistoryPanelOpen: true,
          fileEditorWordWrap: true,
          panelSizes: { gitLogPanelWidth: 500, terminalHeight: 300 },
          rightPanelView: "terminal",
        },
      }),
    ],
  });

  const { ui } = decoded.projects[0];
  assert.equal(ui.changesDiffWordWrap, true);
  assert.equal(ui.chatHistoryPanelOpen, true);
  assert.equal(ui.fileEditorWordWrap, true);
  assert.equal(ui.panelSizes.gitLogPanelWidth, 500);
  assert.equal(ui.panelSizes.terminalHeight, 300);
  assert.equal(ui.panelSizes.leftSidebarWidth, 240);
  assert.equal(ui.rightPanelView, "terminal");
});

test("decode reads the retired panelVisibility and previewUrl fields", () => {
  const decoded = decodePersistedState({
    projects: [
      createRawProject({
        previewUrl: "http://localhost:3000",
        ui: { panelVisibility: { right: false } },
      }),
    ],
  });

  assert.equal(decoded.projects[0].browserUrl, "http://localhost:3000");
  assert.equal(decoded.projects[0].ui.rightPanelOpen, false);
});

test("decode drops projects without an id and retired ui data", () => {
  const decoded = decodePersistedState({
    projects: [
      { name: "no id", path: "/tmp/none", ui: {} },
      createRawProject({
        mcpServerOverrides: { "mcp-github": false },
        ui: {
          kanbanCards: [{ id: "card-one" }],
          pipelineTasks: [],
          tasks: [],
          workspaceView: "pipeline",
        },
      }),
    ],
  });

  assert.equal(decoded.projects.length, 1);
  for (const key of [
    "kanbanCards",
    "pipelineTasks",
    "tasks",
    "workspaceView",
  ]) {
    assert.equal(key in decoded.projects[0].ui, false, key);
  }
  assert.equal("mcpServerOverrides" in decoded.projects[0], false);
});

test("decode reads the retired Tasks workspace as Code", () => {
  for (const appView of ["tasks", "pipeline", "kanban", "bogus", undefined]) {
    assert.equal(decodePersistedState({ appView }).appView, "code");
  }
});

test("decode keeps saved prompts and drops invalid ones", () => {
  const decoded = decodePersistedState({
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
      { id: "prompt-three", name: "Old" },
    ],
  });

  assert.deepEqual(
    decoded.savedPrompts.map((savedPrompt) => savedPrompt.id),
    ["prompt-one", "prompt-two"],
  );
  assert.equal(decoded.savedPrompts[1].name, "");
  assert.equal(
    decoded.savedPrompts[1].updatedAt,
    decoded.savedPrompts[1].createdAt,
  );
});

test("decode normalizes stash items and drops invalid ones", () => {
  const decoded = decodePersistedState({
    projects: [
      createRawProject({
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
                { kind: "bogus" },
              ],
              text: "Ship stash",
              updatedAt: "2026-08-15T12:00:00.000Z",
            },
            { id: "", text: "missing id" },
            { id: "stash-one", text: "duplicate" },
          ],
        },
      }),
    ],
  });

  assert.deepEqual(decoded.projects[0].ui.stashItems, [
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

test("decode creates a default chat for open projects without chats", () => {
  const decoded = decodePersistedState({
    chats: [],
    closedProjects: [createRawProject({ id: "closed", path: "/tmp/closed" })],
    projects: [createRawProject()],
    settings: { defaultPermissionMode: "ask" },
  });

  assert.equal(decoded.chats.length, 1);
  assert.equal(decoded.chats[0].projectId, "project-one");
  assert.equal(decoded.chats[0].title, "New chat");
  assert.equal(decoded.chats[0].permissionMode, "ask");
  assert.deepEqual(decoded.messagesByChatId[decoded.chats[0].id], []);
  assert.equal(decoded.projects[0].ui.activeChatId, decoded.chats[0].id);
  assert.equal(decoded.closedProjects[0].ui.activeChatId, null);
});

test("decode drops chats of unknown projects and duplicate ids", () => {
  const decoded = decodePersistedState({
    chats: [
      createRawChat(),
      createRawChat({ title: "Duplicate" }),
      createRawChat({ id: "chat-orphan", projectId: "missing" }),
    ],
    projects: [createRawProject()],
  });

  assert.deepEqual(
    decoded.chats.map((chat) => chat.id),
    ["chat-one"],
  );
  assert.equal(decoded.chats[0].title, "First chat");
});

test("decode preserves branch lineage without requiring the parent chat", () => {
  const decoded = decodePersistedState({
    chats: [
      createRawChat({
        branchedFrom: { chatId: "deleted-parent", messageId: "message-parent" },
      }),
    ],
    projects: [createRawProject()],
  });

  assert.deepEqual(decoded.chats[0].branchedFrom, {
    chatId: "deleted-parent",
    messageId: "message-parent",
  });
});

test("decode gives a chat without a permission mode the legacy fallback", () => {
  const withoutMode = createRawChat({ permissionMode: undefined });

  assert.equal(
    decodePersistedState({
      chats: [withoutMode],
      projects: [createRawProject()],
    }).chats[0].permissionMode,
    "ask",
  );
  assert.equal(
    decodePersistedState({
      chats: [withoutMode],
      projects: [createRawProject()],
      settings: { autoAcceptPermissions: true },
    }).chats[0].permissionMode,
    "full-access",
  );
  assert.equal(
    decodePersistedState({
      chats: [createRawChat({ agentMode: "plan", permissionMode: "standard" })],
      projects: [createRawProject()],
    }).chats[0].permissionMode,
    "ask",
  );
});

test("decode drops closed projects that duplicate open ones", () => {
  const decoded = decodePersistedState({
    closedProjects: [
      createRawProject({
        id: "project-closed",
        path: "/home/user/project-one/",
      }),
      createRawProject({
        id: "project-two",
        name: "Two",
        path: "/home/user/two",
      }),
    ],
    projects: [createRawProject()],
  });

  assert.deepEqual(
    decoded.closedProjects.map((project) => project.id),
    ["project-two"],
  );
});

test("decode keeps browser tabs of known projects and picks an active tab", () => {
  const decoded = decodePersistedState({
    activeBrowserTabIdByProject: { "project-one": "gone" },
    browserTabsByProject: {
      "project-one": [
        { id: "tab-a", url: "http://a" },
        { id: "tab-a" },
        { id: "" },
      ],
      unknown: [{ id: "tab-b" }],
    },
    projects: [createRawProject()],
  });

  assert.deepEqual(Object.keys(decoded.browserTabsByProject), ["project-one"]);
  assert.equal(decoded.browserTabsByProject["project-one"].length, 1);
  assert.equal(decoded.browserTabsByProject["project-one"][0].title, "New Tab");
  assert.deepEqual(decoded.activeBrowserTabIdByProject, {
    "project-one": "tab-a",
  });
});

test("decode defaults and reads the new-chat and text generation settings", () => {
  const defaulted = decodePersistedState({ settings: {} }).settings;
  assert.equal(defaulted.defaultPermissionMode, "full-access");
  // Profiles from before the setting keep the original low effort.
  assert.equal(defaulted.defaultGitGenerationReasoningEffort, "low");
  assert.equal(defaulted.defaultGitGenerationModelSpeed, "standard");
  assert.equal(defaulted.autoCompactContext, true);
  assert.equal(defaulted.changeCheckpoints, true);

  const read = decodePersistedState({
    settings: {
      autoCompactContext: false,
      changeCheckpoints: false,
      defaultGitGenerationModelSpeed: "fast",
      // `null` is the explicit "medium" choice and must not become "low".
      defaultGitGenerationReasoningEffort: null,
      defaultPermissionMode: "auto-accept-edits",
      locale: "zh-TW",
    },
  }).settings;
  assert.equal(read.autoCompactContext, false);
  assert.equal(read.changeCheckpoints, false);
  assert.equal(read.defaultPermissionMode, "auto-accept-edits");
  assert.equal(read.defaultGitGenerationReasoningEffort, null);
  assert.equal(read.defaultGitGenerationModelSpeed, "fast");
  assert.equal(read.locale, "zh-Hant");
});

test("decode understands the retired settings names and repairs stale defaults", () => {
  const settings = decodePersistedState({
    settings: {
      autoArchiveChatsAfterDays: 7,
      defaultModel: "gone-model",
      expandShellToolParts: true,
      openAiSelectedModels: ["gpt-5", " gpt-5 "],
    },
  }).settings;

  assert.equal(settings.archiveChatsAfterDays, 7);
  assert.equal(settings.expandToolCalls, true);
  assert.deepEqual(settings.openAiSelectedModels, ["gpt-5"]);
  assert.equal(settings.defaultModel, "gpt-5");
  assert.equal(settings.defaultGitGenerationModel, "gpt-5");
});

test("decode fills an empty project model from the default model", () => {
  const decoded = decodePersistedState({
    projects: [createRawProject({ model: "" })],
    settings: { defaultModel: "gpt-5", openAiSelectedModels: ["gpt-5"] },
  });

  assert.equal(decoded.projects[0].model, "gpt-5");
});

// ── encode ────────────────────────────────────────────────────────────

const createLiveState = (project, chats, overrides = {}) => ({
  activeBrowserTabIdByProject: {},
  activeProjectId: project.id,
  appView: "code",
  browserTabsByProject: {},
  chats,
  chatSort: "recent",
  closedProjects: [],
  messagesByChatId: {},
  projects: [project],
  savedPrompts: [],
  settings: DEFAULT_SETTINGS,
  ...overrides,
});

const decodedProject = () =>
  decodePersistedState({ projects: [createRawProject()] }).projects[0];

test("encode drops empty draft chats unless they are open, pinned, or deleted", () => {
  const project = decodedProject();
  const draft = createChatConfig(project, { title: "Draft" });
  const open = createChatConfig(project, { title: "Open" });
  const pinned = {
    ...createChatConfig(project, { title: "Pinned" }),
    pinned: true,
  };
  const deleted = {
    ...createChatConfig(project, { title: "Deleted" }),
    deletedAt: "2026-07-19T12:00:00.000Z",
  };
  const withMessages = createChatConfig(project, { title: "Messages" });

  const encoded = encodePersistedState(
    createLiveState(
      { ...project, ui: { ...project.ui, activeChatId: open.id } },
      [draft, open, pinned, deleted, withMessages],
      { messagesByChatId: { [withMessages.id]: [userMessage] } },
    ),
  );

  assert.deepEqual(
    encoded.chats.map((chat) => chat.id),
    [open.id, pinned.id, deleted.id, withMessages.id],
  );
  assert.deepEqual(Object.keys(encoded.messagesByChatId), [withMessages.id]);
  assert.equal(encoded.projects[0].ui.activeChatId, open.id);
});

test("encode keeps a transcript key only when the renderer has it loaded", () => {
  const project = decodedProject();
  const chat = { ...createChatConfig(project), messageCount: 3 };

  const encoded = encodePersistedState(createLiveState(project, [chat]));

  assert.deepEqual(
    encoded.chats.map((c) => c.id),
    [chat.id],
  );
  assert.deepEqual(encoded.messagesByChatId, {});
});

test("encode drops chats and browser tabs of unknown projects", () => {
  const project = decodedProject();
  const chat = { ...createChatConfig(project), projectId: "unknown" };

  const encoded = encodePersistedState(
    createLiveState(project, [chat], {
      activeProjectId: "unknown",
      browserTabsByProject: { unknown: [{ id: "tab" }] },
    }),
  );

  assert.deepEqual(encoded.chats, []);
  assert.deepEqual(encoded.browserTabsByProject, {});
  assert.equal(encoded.activeProjectId, project.id);
});

test("encode then decode is the identity on a decoded state", () => {
  const decoded = decodePersistedState({
    activeProjectId: "project-one",
    chats: [createRawChat({ messageCount: 2, pinned: true })],
    projects: [createRawProject({ ui: { fileEditorWordWrap: true } })],
    savedPrompts: [{ id: "prompt-one", prompt: "Do it", name: "Do" }],
    settings: { locale: "fr", openAiSelectedModels: ["gpt-5"] },
  });

  assert.deepEqual(
    decodePersistedState(encodePersistedState(decoded)),
    decoded,
  );
});

// ── rows ──────────────────────────────────────────────────────────────

test("a project survives the row round trip", () => {
  const project = decodePersistedState({
    projects: [
      createRawProject({
        browserUrl: "http://localhost:5173",
        icon: {
          path: "/icons/one.png",
          mimeType: "image/png",
          source: "custom",
          mtimeMs: 5,
        },
        lastUsedAt: "2026-07-19T12:00:00.000Z",
        model: "gpt-5",
        modelSpeed: "fast",
        reasoningEffort: "high",
        runCommand: "pnpm start",
        ui: { fileEditorWordWrap: true, rightPanelOpen: false },
        worktree: {
          baseRef: "main",
          branch: "feature",
          createdAt: "2026-07-19T12:00:00.000Z",
          kind: "worktree",
          mainWorktreePath: "/home/user/project-one",
          managed: true,
          parentProjectId: "parent",
          repoRoot: "/home/user/project-one",
        },
      }),
    ],
    settings: { openAiSelectedModels: ["gpt-5"] },
  }).projects[0];

  const row = projectToRow(project, "closed", 3);
  assert.equal(row.normalizedPath, "/home/user/project-one");
  assert.equal(row.status, "closed");
  assert.equal(row.sortOrder, 3);

  const decoded = decodePersistedState({
    projects: [projectFromRow(row)],
    settings: { openAiSelectedModels: ["gpt-5"] },
  }).projects[0];
  // Both decodes give the project a fresh default chat; compare the rest.
  const withoutChat = (value) => ({
    ...value,
    ui: { ...value.ui, activeChatId: null, openChatIds: [] },
  });
  assert.deepEqual(withoutChat(decoded), withoutChat(project));
});

test("a chat survives the row round trip, with the live message count", () => {
  const project = decodedProject();
  const chat = decodePersistedState({
    chats: [
      createRawChat({
        branchedFrom: { chatId: "parent", messageId: "message" },
        deletedAt: "2026-07-20T12:00:00.000Z",
        messageCount: 4,
        permissionMode: "auto-accept-edits",
        pinned: true,
        reasoningEffort: "high",
        remoteConversationId: "remote-1",
        remoteConversationModel: "gpt-5",
        remoteConversationModelSpeed: "fast",
        remoteConversationProjectPath: "/home/user/project-one",
        sparklesPalette: "ember",
      }),
    ],
    projects: [createRawProject()],
  }).chats[0];

  const row = chatToRow(chat);
  assert.equal(row.deletedAt, "2026-07-20T12:00:00.000Z");
  const raw = chatFromRow({
    id: row.id,
    project_id: row.projectId,
    title: row.title,
    metadata: row.metadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    deleted_at: row.deletedAt,
    message_count: 9,
  });

  const decoded = decodePersistedState({
    chats: [raw],
    projects: [createRawProject()],
  }).chats[0];
  assert.deepEqual(decoded, { ...chat, messageCount: 9 });
  assert.equal(project.id, decoded.projectId);
});

test("config rows keep a stored null apart from a missing key", () => {
  const state = decodePersistedState({
    settings: { defaultGitGenerationReasoningEffort: null },
  });
  const config = stateToConfig(state);
  assert.equal(config["settings.defaultGitGenerationReasoningEffort"], null);
  assert.equal(config.appView, "code");

  const raw = stateFromConfig(config);
  assert.equal(raw.settings.defaultGitGenerationReasoningEffort, null);
  assert.equal(
    decodePersistedState(raw).settings.defaultGitGenerationReasoningEffort,
    null,
  );
  assert.equal(
    decodePersistedState(stateFromConfig({})).settings
      .defaultGitGenerationReasoningEffort,
    "low",
  );
});

// ── invariants ────────────────────────────────────────────────────────

test("ensureActiveProject keeps a valid selection and falls back to the first project", () => {
  const projects = [
    decodedProject(),
    decodePersistedState({
      projects: [createRawProject({ id: "project-two", path: "/two" })],
    }).projects[0],
  ];

  assert.equal(ensureActiveProject(projects, "project-two"), "project-two");
  assert.equal(ensureActiveProject(projects, "project-missing"), "project-one");
  assert.equal(ensureActiveProject(projects, null), "project-one");
  assert.equal(ensureActiveProject([], "project-one"), null);
});

test("ensureActiveChatForProject ignores deleted chats and other projects", () => {
  const chats = [
    createRawChat({
      deletedAt: "2026-07-19T12:30:00.000Z",
      id: "chat-deleted",
    }),
    createRawChat({ id: "chat-live" }),
    createRawChat({ id: "chat-other", projectId: "project-two" }),
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
