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
    assert.deepEqual(loaded.projects[0]?.ui.stashItems, project.ui.stashItems);
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

const createStoredTask = (id, timestamp, overrides = {}) => ({
  createdAt: timestamp,
  id,
  prompt: `Prompt for ${id}`,
  title: id,
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

test("tasks survive a relational persistence round trip, app-wide and in order", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-09-01T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  const tasks = [
    createStoredTask("task-two", timestamp, {
      prompt: "Address the review comments on {{branch}}",
      title: "Address review",
      updatedAt: "2026-09-02T12:00:00.000Z",
    }),
    createStoredTask("task-one", timestamp),
  ];

  try {
    savePersistedState(createState(project, { tasks }), { databasePath });
    assert.deepEqual(loadPersistedState({ databasePath }).tasks, tasks);

    // Tasks belong to no project, so they outlive every project.
    savePersistedState(
      createState(project, { activeProjectId: null, projects: [], tasks }),
      { databasePath },
    );
    assert.deepEqual(loadPersistedState({ databasePath }).tasks, tasks);

    // Deleting and reordering is a save of the new list.
    savePersistedState(createState(project, { tasks: [tasks[1]] }), {
      databasePath,
    });
    assert.deepEqual(loadPersistedState({ databasePath }).tasks, [tasks[1]]);

    // A state that says nothing about tasks leaves them alone.
    savePersistedState(createState(project), { databasePath });
    assert.deepEqual(loadPersistedState({ databasePath }).tasks, [tasks[1]]);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("tasks without a prompt or with a duplicate id are not saved", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-09-01T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  const valid = createStoredTask("task-one", timestamp);

  try {
    savePersistedState(
      createState(project, {
        tasks: [
          valid,
          { ...valid, title: "Duplicate" },
          // A pipeline task from before tasks were saved prompts.
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

    assert.deepEqual(loadPersistedState({ databasePath }).tasks, [valid]);
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
    assert.deepEqual(loaded.tasks, []);
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

test("the schema stores tasks as prompts, and chats no longer link to tasks", async () => {
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

    assert.deepEqual(columnsOf("tasks"), [
      "created_at",
      "id",
      "prompt",
      "sort_order",
      "title",
      "updated_at",
    ]);
    assert.equal(columnsOf("chats").includes("task_id"), false);
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
