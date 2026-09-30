import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  closePersistedStateDatabase,
  getPersistedStateDatabase,
  loadPersistedChatMessages,
  loadPersistedState,
  savePersistedActiveProject,
  savePersistedState,
} from "./persisted-state.js";
import {
  createChatConfig,
  DEFAULT_PROJECT_UI,
  DEFAULT_SETTINGS,
} from "./shared/persisted-state-codec.js";

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
    stashItems: [],
  },
  worktree: null,
});

test("active-project persistence updates only selection metadata", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const firstLastUsedAt = "2026-07-19T12:00:00.000Z";
  const secondLastUsedAt = "2026-07-19T12:01:00.000Z";

  try {
    savePersistedState(
      {
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
      },
      { databasePath },
    );

    assert.equal(
      savePersistedActiveProject(
        {
          activeProjectId: "project-two",
          lastUsedAt: secondLastUsedAt,
        },
        { databasePath },
      ),
      true,
    );

    const updated = loadPersistedState({ databasePath });
    assert.equal(updated.activeProjectId, "project-two");
    assert.equal(updated.projects.length, 2);
    assert.equal(
      updated.projects.find((project) => project.id === "project-two")
        ?.lastUsedAt,
      secondLastUsedAt,
    );
    assert.equal(
      updated.projects.find((project) => project.id === "project-one")
        ?.lastUsedAt,
      firstLastUsedAt,
    );
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("stash items survive a relational persistence round trip", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  project.ui.rightPanelView = "stash";
  project.ui.stashItems = [
    {
      agentMode: "plan",
      createdAt: timestamp,
      id: "stash-one",
      model: "gpt-5",
      modelSpeed: "fast",
      permissionMode: "standard",
      provider: "openai",
      reasoningEffort: "high",
      references: [],
      text: "queued work",
      updatedAt: timestamp,
    },
  ];

  try {
    savePersistedState(
      {
        activeBrowserTabIdByProject: {},
        activeProjectId: project.id,
        browserTabsByProject: {},
        chats: [],
        chatSort: "recent",
        closedProjects: [],
        messagesByChatId: {},
        projects: [project],
        settings: {},
      },
      { databasePath },
    );

    const loaded = loadPersistedState({ databasePath });
    assert.equal(loaded.projects[0]?.ui.rightPanelView, "stash");
    // The retired Standard mode under Plan reads as "ask"; agentMode is gone.
    const { agentMode: _agentMode, ...stashItem } = project.ui.stashItems[0];
    assert.deepEqual(loaded.projects[0]?.ui.stashItems, [
      { ...stashItem, permissionMode: "ask" },
    ]);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("chat branch lineage survives a relational persistence round trip", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-05T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  project.ui.activeChatId = "branch-chat";
  project.ui.openChatIds = ["branch-chat"];

  try {
    savePersistedState(
      {
        activeBrowserTabIdByProject: {},
        activeProjectId: project.id,
        browserTabsByProject: {},
        chats: [
          {
            agentMode: "build",
            branchedFrom: {
              chatId: "deleted-parent",
              messageId: "parent-message",
            },
            createdAt: timestamp,
            deletedAt: null,
            id: "branch-chat",
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
            sparklesPalette: "default",
            title: "Branch",
            updatedAt: timestamp,
          },
        ],
        chatSort: "recent",
        closedProjects: [],
        messagesByChatId: {
          "branch-chat": [
            {
              id: "branch-message",
              parts: [{ text: "hello", type: "text" }],
              role: "user",
            },
          ],
        },
        projects: [project],
        settings: {},
      },
      { databasePath },
    );

    const loaded = loadPersistedState({ databasePath });
    assert.deepEqual(loaded.chats[0]?.branchedFrom, {
      chatId: "deleted-parent",
      messageId: "parent-message",
    });
    assert.equal(loaded.chats[0]?.messageCount, 1);
    assert.deepEqual(loaded.messagesByChatId, {});
    assert.deepEqual(
      loadPersistedChatMessages("branch-chat", { databasePath }),
      [
        {
          id: "branch-message",
          parts: [{ text: "hello", type: "text" }],
          role: "user",
        },
      ],
    );

    savePersistedState(
      {
        activeBrowserTabIdByProject: {},
        activeProjectId: project.id,
        browserTabsByProject: {},
        chats: loaded.chats,
        chatSort: "recent",
        closedProjects: [],
        messagesByChatId: {},
        projects: [project],
        settings: {},
      },
      { databasePath },
    );

    assert.equal(
      loadPersistedChatMessages("branch-chat", { databasePath }).length,
      1,
      "metadata-only saves preserve lazy message rows",
    );
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("MCP servers and project overrides survive a persistence round trip", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const server = {
    args: ["-y", "@modelcontextprotocol/server-github"],
    command: "npx",
    createdAt: "2026-07-19T12:00:00.000Z",
    enabled: true,
    env: { GITHUB_TOKEN: "token" },
    headers: {},
    id: "mcp-github",
    name: "github",
    transport: "stdio",
    url: "",
  };

  try {
    savePersistedState(
      {
        activeBrowserTabIdByProject: {},
        activeProjectId: "project-one",
        browserTabsByProject: {},
        chats: [],
        chatSort: "recent",
        closedProjects: [],
        messagesByChatId: {},
        projects: [
          {
            ...createProject("project-one", "2026-07-19T12:00:00.000Z"),
            mcpServerOverrides: { "mcp-github": false, junk: "no" },
          },
        ],
        settings: { mcpServers: [server, { id: "invalid" }] },
      },
      { databasePath },
    );

    const loaded = loadPersistedState({ databasePath });
    assert.deepEqual(loaded.settings.mcpServers, [server]);
    assert.equal(loaded.projects[0].mcpServerOverrides, undefined);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

const createState = (project, overrides = {}) => ({
  activeBrowserTabIdByProject: {},
  activeProjectId: project.id,
  browserTabsByProject: {},
  chats: [],
  chatSort: "recent",
  closedProjects: [],
  messagesByChatId: {},
  projects: [project],
  settings: {},
  ...overrides,
});

const createStoredSavedPrompt = (id, timestamp, overrides = {}) => ({
  createdAt: timestamp,
  id,
  prompt: `Prompt for ${id}`,
  name: id,
  updatedAt: timestamp,
  ...overrides,
});

const createStoredChat = (id, projectId, timestamp, overrides = {}) => ({
  agentMode: "build",
  branchedFrom: null,
  createdAt: timestamp,
  deletedAt: null,
  id,
  model: "gpt-5.6",
  modelSpeed: "standard",
  permissionMode: "full-access",
  projectId,
  provider: "openai",
  reasoningEffort: null,
  remoteConversationId: null,
  remoteConversationModel: null,
  remoteConversationModelSpeed: null,
  remoteConversationProjectPath: null,
  sparklesPalette: "default",
  title: id,
  updatedAt: timestamp,
  ...overrides,
});

test("the retired Tasks workspace loads as Code", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const project = createProject("project-one", "2026-08-15T12:00:00.000Z");

  try {
    for (const appView of ["tasks", "pipeline", "not-a-view"]) {
      savePersistedState(createState(project, { appView }), { databasePath });
      assert.equal(loadPersistedState({ databasePath }).appView, "code");
    }
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("saved prompts survive a relational persistence round trip, app-wide and in order", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-09-01T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  const savedPrompts = [
    createStoredSavedPrompt("prompt-two", timestamp, {
      prompt: "Address the review comments on {{branch}}",
      name: "Address review",
      updatedAt: "2026-09-02T12:00:00.000Z",
    }),
    createStoredSavedPrompt("prompt-one", timestamp),
  ];

  try {
    savePersistedState(createState(project, { savedPrompts }), {
      databasePath,
    });
    assert.deepEqual(
      loadPersistedState({ databasePath }).savedPrompts,
      savedPrompts,
    );

    // Saved prompts belong to no project, so they outlive every project.
    savePersistedState(
      createState(project, {
        activeProjectId: null,
        projects: [],
        savedPrompts,
      }),
      { databasePath },
    );
    assert.deepEqual(
      loadPersistedState({ databasePath }).savedPrompts,
      savedPrompts,
    );

    // Deleting and reordering is a save of the new list.
    savePersistedState(
      createState(project, { savedPrompts: [savedPrompts[1]] }),
      {
        databasePath,
      },
    );
    assert.deepEqual(loadPersistedState({ databasePath }).savedPrompts, [
      savedPrompts[1],
    ]);

    // A state that says nothing about saved prompts leaves them alone.
    savePersistedState(createState(project), { databasePath });
    assert.deepEqual(loadPersistedState({ databasePath }).savedPrompts, [
      savedPrompts[1],
    ]);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("saved prompts without a prompt or with a duplicate id are not saved", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-09-01T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  const valid = createStoredSavedPrompt("prompt-one", timestamp);

  try {
    savePersistedState(
      createState(project, {
        savedPrompts: [
          valid,
          { ...valid, name: "Duplicate" },
          // No prompt text.
          {
            createdAt: timestamp,
            description: "Old",
            id: "task-pipeline",
            projectId: project.id,
            runs: [],
            step: "plan",
            title: "Old",
          },
          { prompt: "No id" },
        ],
      }),
      { databasePath },
    );

    assert.deepEqual(loadPersistedState({ databasePath }).savedPrompts, [
      valid,
    ]);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("task pipeline data carried on projects is dropped on save", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const project = createProject("project-one", "2026-08-15T12:00:00.000Z");
  project.ui = {
    ...project.ui,
    kanbanCards: [{ id: "card-one", title: "Card" }],
    pipelineConfig: { plan: { prompt: "Old" } },
    pipelineTasks: [{ id: "task-old", title: "Old" }],
    taskConfig: { plan: { prompt: "Old" } },
    tasks: [{ id: "task-one", step: "plan", title: "Old" }],
    workspaceView: "pipeline",
  };

  try {
    savePersistedState(createState(project), { databasePath });

    const loaded = loadPersistedState({ databasePath });
    assert.deepEqual(loaded.savedPrompts, []);
    const database = getPersistedStateDatabase({ databasePath });
    const { ui } = JSON.parse(
      database
        .prepare("SELECT metadata FROM projects WHERE id = ?")
        .get(project.id).metadata,
    );
    for (const key of [
      "kanbanCards",
      "pipelineConfig",
      "pipelineTasks",
      "taskConfig",
      "tasks",
      "workspaceView",
    ]) {
      assert.equal(Object.hasOwn(ui, key), false, key);
    }
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("the schema stores saved prompts, and chats no longer link to tasks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");

  try {
    const database = getPersistedStateDatabase({ databasePath });
    const columnsOf = (table) =>
      database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name)
        .sort();

    assert.deepEqual(columnsOf("saved_prompts"), [
      "created_at",
      "id",
      "name",
      "prompt",
      "sort_order",
      "updated_at",
    ]);
    assert.deepEqual(columnsOf("tasks"), []);
    assert.equal(columnsOf("chats").includes("task_id"), false);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

// Puts a migrated database back to how it looked before saved prompts, so the
// saved prompts migration runs again on the next open.
const rewindSavedPromptsMigration = (databasePath, tasksTableSql) => {
  const database = getPersistedStateDatabase({ databasePath });
  database.exec(`
    DROP TABLE saved_prompts;
    ${tasksTableSql}
    DELETE FROM __drizzle_migrations
      WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations);
  `);
  return database;
};

test("a v0.21.0 database drops the task pipeline on upgrade", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-09-01T12:00:00.000Z";
  const project = createProject("project-one", timestamp);

  try {
    savePersistedState(createState(project), { databasePath });
    const database = rewindSavedPromptsMigration(
      databasePath,
      `
        CREATE TABLE tasks (
          id text PRIMARY KEY NOT NULL,
          project_id text NOT NULL,
          step text DEFAULT 'backlog' NOT NULL,
          title text NOT NULL,
          sort_order integer DEFAULT 0 NOT NULL,
          payload text DEFAULT '{}' NOT NULL,
          created_at text NOT NULL,
          updated_at text NOT NULL
        );
        ALTER TABLE chats ADD COLUMN task_id TEXT NULL;
        CREATE INDEX idx_chats_task ON chats (task_id);
      `,
    );
    database
      .prepare(
        `
          INSERT INTO tasks (id, project_id, step, title, created_at, updated_at)
          VALUES (?, ?, 'plan', 'Old', ?, ?)
        `,
      )
      .run("task-pipeline", project.id, timestamp, timestamp);
    closePersistedStateDatabase();

    assert.deepEqual(loadPersistedState({ databasePath }).savedPrompts, []);
    const upgraded = getPersistedStateDatabase({ databasePath });
    const columnsOf = (table) =>
      upgraded
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name);
    assert.deepEqual(columnsOf("tasks"), []);
    assert.equal(columnsOf("chats").includes("task_id"), false);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("saved tasks from a pre-release build carry over as saved prompts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-09-01T12:00:00.000Z";

  try {
    savePersistedState(createState(createProject("project-one", timestamp)), {
      databasePath,
    });
    const database = rewindSavedPromptsMigration(
      databasePath,
      `
        CREATE TABLE tasks (
          id text PRIMARY KEY NOT NULL,
          title text NOT NULL,
          prompt text DEFAULT '' NOT NULL,
          sort_order integer DEFAULT 0 NOT NULL,
          created_at text NOT NULL,
          updated_at text NOT NULL
        );
      `,
    );
    database
      .prepare(
        `
          INSERT INTO tasks (id, title, prompt, sort_order, created_at, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)
        `,
      )
      .run("prompt-one", "Review", "Address the review", timestamp, timestamp);
    closePersistedStateDatabase();

    assert.deepEqual(loadPersistedState({ databasePath }).savedPrompts, [
      {
        createdAt: timestamp,
        id: "prompt-one",
        name: "Review",
        prompt: "Address the review",
        updatedAt: timestamp,
      },
    ]);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("a chat that moves to another project keeps its transcript", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  const worktree = createProject("project-one-worktree", timestamp);
  const message = {
    id: "chat-message",
    parts: [{ text: "build it", type: "text" }],
    role: "user",
  };

  try {
    savePersistedState(
      createState(project, {
        chats: [createStoredChat("moved-chat", worktree.id, timestamp)],
        messagesByChatId: { "moved-chat": [message] },
        projects: [project, worktree],
      }),
      { databasePath },
    );

    // The chat moves and its old project is dropped in the same save. The
    // transcript is not loaded, so this save carries no messages for it.
    savePersistedState(
      createState(project, {
        chats: [createStoredChat("moved-chat", project.id, timestamp)],
      }),
      { databasePath },
    );

    const loaded = loadPersistedState({ databasePath });
    assert.deepEqual(
      loaded.chats.map((chat) => [chat.id, chat.projectId]),
      [["moved-chat", project.id]],
    );
    assert.deepEqual(
      loadPersistedChatMessages("moved-chat", { databasePath }),
      [message],
      "moving the chat must not cascade away its transcript",
    );

    // The same holds when the chat's new project is first saved in the very
    // save that drops its old one.
    const successor = createProject("project-two", timestamp);
    savePersistedState(
      createState(successor, {
        chats: [createStoredChat("moved-chat", successor.id, timestamp)],
        projects: [successor],
      }),
      { databasePath },
    );
    assert.deepEqual(
      loadPersistedChatMessages("moved-chat", { databasePath }),
      [message],
    );
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("new-chat and text generation settings survive a persistence round trip", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");

  try {
    const project = createProject("project-one", "2026-07-19T12:00:00.000Z");
    savePersistedState(
      {
        ...createState(project),
        settings: {
          defaultGitGenerationModelSpeed: "fast",
          defaultGitGenerationReasoningEffort: null,
          defaultPermissionMode: "ask",
          disabledProviders: ["cursor"],
        },
      },
      { databasePath },
    );

    const loaded = loadPersistedState({ databasePath });
    assert.equal(loaded.settings.defaultGitGenerationModelSpeed, "fast");
    assert.equal(loaded.settings.defaultGitGenerationReasoningEffort, null);
    assert.equal(loaded.settings.defaultPermissionMode, "ask");
    assert.deepEqual(loaded.settings.disabledProviders, ["cursor"]);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

// ── Every persisted field survives ────────────────────────────────────
//
// A fixture where every persisted field carries a non-default value, saved
// through SQLite and loaded back. The completeness guard fails as soon as a
// field is added to the defaults without being added here, so a new field
// cannot be persisted on one side of the IPC seam only.

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const leafPaths = (value, prefix = []) =>
  isPlainObject(value) && Object.keys(value).length > 0
    ? Object.entries(value).flatMap(([key, child]) =>
        leafPaths(child, [...prefix, key]),
      )
    : [prefix];

const readPath = (value, path) =>
  path.reduce((current, key) => current?.[key], value);

const assertEveryFieldPopulated = (fixture, defaults, label) => {
  for (const path of leafPaths(defaults)) {
    const name = `${label}.${path.join(".")}`;
    const fixtureValue = readPath(fixture, path);
    assert.notEqual(
      fixtureValue,
      undefined,
      `${name} is missing from the fixture`,
    );
    assert.notEqual(
      JSON.stringify(fixtureValue),
      JSON.stringify(readPath(defaults, path)),
      `${name} must carry a non-default value so the round trip proves it`,
    );
  }
};

const FULL_CHAT_ID = "chat-full";
const FULL_TIMESTAMP = "2026-09-01T12:00:00.000Z";

const FULL_SETTINGS = {
  archiveChatsAfterDays: 14,
  autoCompactContext: false,
  anthropicSelectedModels: ["opus"],
  defaultGitGenerationModel: "opus",
  defaultGitGenerationModelSpeed: "fast",
  defaultGitGenerationReasoningEffort: "high",
  defaultModel: "gpt-5",
  defaultModelSpeed: "fast",
  defaultPermissionMode: "ask",
  defaultReasoningEffort: "high",
  disabledProviders: ["cursor"],
  changeCheckpoints: false,
  expandToolCalls: true,
  groupToolCalls: true,
  cursorSelectedModels: ["cursor-composer"],
  grokSelectedModels: ["grok-4"],
  locale: "fr",
  mcpServers: [
    {
      args: ["-y", "@modelcontextprotocol/server-github"],
      command: "npx",
      createdAt: FULL_TIMESTAMP,
      enabled: true,
      env: { GITHUB_TOKEN: "token" },
      headers: {},
      id: "mcp-github",
      name: "github",
      transport: "stdio",
      url: "",
    },
  ],
  openAiSelectedModels: ["gpt-5"],
  openCodeSelectedModels: ["opencode/gpt-5"],
  showReasoningSummaries: false,
  shellPath: "/bin/zsh",
};

const FULL_PROJECT_UI = {
  activeChatId: FULL_CHAT_ID,
  openChatIds: [FULL_CHAT_ID],
  chatColumnWidths: { [FULL_CHAT_ID]: 480 },
  chatHistoryPanelOpen: true,
  changesDiffWordWrap: true,
  fileEditorWordWrap: true,
  multiChat: true,
  panelSizes: {
    chatHistoryPanelWidth: 450,
    gitLogPanelWidth: 500,
    leftSidebarWidth: 300,
    rightPanelWidth: 600,
    terminalHeight: 320,
  },
  rightPanelOpen: false,
  rightPanelView: "terminal",
  stashItems: [
    {
      createdAt: FULL_TIMESTAMP,
      id: "stash-full",
      model: "gpt-5",
      modelSpeed: "fast",
      permissionMode: "auto-accept-edits",
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
      text: "Ship it",
      updatedAt: FULL_TIMESTAMP,
    },
  ],
};

const FULL_PROJECT = {
  browserUrl: "http://localhost:5173",
  icon: {
    mimeType: "image/png",
    mtimeMs: 12,
    path: "/icons/full.png",
    source: "custom",
  },
  id: "project-full",
  lastUsedAt: FULL_TIMESTAMP,
  model: "gpt-5",
  modelSpeed: "fast",
  name: "Full Project",
  path: "/home/user/full-project",
  provider: "openai",
  reasoningEffort: "high",
  runCommand: "pnpm start",
  ui: FULL_PROJECT_UI,
  worktree: {
    baseRef: "main",
    branch: "feature/full",
    createdAt: FULL_TIMESTAMP,
    kind: "worktree",
    mainWorktreePath: "/home/user/full-project-main",
    managed: true,
    parentProjectId: "project-parent",
    repoRoot: "/home/user/full-project-main",
  },
};

const FULL_CHAT = {
  branchedFrom: { chatId: "chat-parent", messageId: "message-parent" },
  createdAt: FULL_TIMESTAMP,
  deletedAt: null,
  id: FULL_CHAT_ID,
  messageCount: 2,
  model: "opus",
  modelSpeed: "fast",
  permissionMode: "auto-accept-edits",
  pinned: true,
  projectId: FULL_PROJECT.id,
  provider: "anthropic",
  reasoningEffort: "high",
  remoteConversationId: "remote-full",
  remoteConversationModel: "opus",
  remoteConversationModelSpeed: "fast",
  remoteConversationProjectPath: "/home/user/full-project",
  sparklesPalette: "ember",
  title: "Full chat",
  updatedAt: "2026-09-02T12:00:00.000Z",
};

test("every persisted field survives a relational round trip", async () => {
  assertEveryFieldPopulated(FULL_SETTINGS, DEFAULT_SETTINGS, "settings");
  assertEveryFieldPopulated(FULL_PROJECT_UI, DEFAULT_PROJECT_UI, "project.ui");
  for (const key of Object.keys(createChatConfig(FULL_PROJECT))) {
    assert.ok(key in FULL_CHAT, `chat.${key} is missing from the fixture`);
  }

  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const messages = [
    { id: "m1", parts: [{ text: "one", type: "text" }], role: "user" },
    { id: "m2", parts: [{ text: "two", type: "text" }], role: "assistant" },
  ];

  try {
    savePersistedState(
      {
        activeBrowserTabIdByProject: { [FULL_PROJECT.id]: "tab-two" },
        activeProjectId: FULL_PROJECT.id,
        appView: "code",
        browserTabsByProject: {
          [FULL_PROJECT.id]: [
            {
              canGoBack: false,
              canGoForward: false,
              id: "tab-one",
              title: "One",
              url: "http://one",
              zoomFactor: 1,
            },
            {
              canGoBack: true,
              canGoForward: false,
              id: "tab-two",
              title: "Two",
              url: "http://two",
              zoomFactor: 1.25,
            },
          ],
        },
        chats: [FULL_CHAT],
        chatSort: "titleAsc",
        closedProjects: [],
        messagesByChatId: { [FULL_CHAT_ID]: messages },
        projects: [FULL_PROJECT],
        savedPrompts: [
          {
            createdAt: FULL_TIMESTAMP,
            id: "prompt-full",
            name: "Full",
            prompt: "Do everything",
            updatedAt: FULL_TIMESTAMP,
          },
        ],
        settings: FULL_SETTINGS,
      },
      { databasePath },
    );

    const loaded = loadPersistedState({ databasePath });
    assert.deepEqual(loaded.settings, FULL_SETTINGS);
    assert.deepEqual(loaded.projects, [FULL_PROJECT]);
    assert.deepEqual(loaded.chats, [FULL_CHAT]);
    assert.deepEqual(loaded.messagesByChatId, {});
    assert.equal(loaded.activeProjectId, FULL_PROJECT.id);
    assert.equal(loaded.chatSort, "titleAsc");
    assert.equal(loaded.appView, "code");
    assert.deepEqual(loaded.activeBrowserTabIdByProject, {
      [FULL_PROJECT.id]: "tab-two",
    });
    assert.equal(loaded.browserTabsByProject[FULL_PROJECT.id].length, 2);
    assert.equal(loaded.savedPrompts.length, 1);
    assert.deepEqual(
      loadPersistedChatMessages(FULL_CHAT_ID, { databasePath }),
      messages,
    );
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});
