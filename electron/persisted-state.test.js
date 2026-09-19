import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  closePersistedStateDatabase,
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
    pipelineConfig: {},
    pipelineTasks: [],
    workspaceView: "code",
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
    assert.deepEqual(loaded.projects[0].mcpServerOverrides, {
      "mcp-github": false,
    });
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("workspace view survives a relational persistence round trip", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  project.ui.workspaceView = "pipeline";

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
    assert.equal(loaded.projects[0]?.ui.workspaceView, "pipeline");
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("workspace view falls back to code when missing or invalid", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  project.ui.workspaceView = "not-a-workspace";

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
    assert.equal(loaded.projects[0]?.ui.workspaceView, "code");
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

const saveProject = (project, databasePath) =>
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

test("pipeline tasks and step config survive a relational persistence round trip", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  project.ui.workspaceView = "pipeline";
  project.ui.pipelineConfig = {
    build: {
      agentMode: "build",
      autoAdvance: false,
      model: null,
      permissionMode: "full-access",
      prompt: "Custom build prompt",
    },
  };
  project.ui.pipelineTasks = [
    {
      baseRef: "main",
      branch: "pipeline/ship-it",
      completion: null,
      createdAt: timestamp,
      description: "Add a pipeline",
      id: "task-one",
      runs: [
        {
          chatId: "chat-1",
          feedback: null,
          finishedAt: timestamp,
          id: "run-1",
          output: "The plan",
          startedAt: timestamp,
          step: "plan",
        },
      ],
      step: "plan",
      title: "Ship pipeline",
      updatedAt: timestamp,
      worktreePath: "/workspace/ship-it",
      worktreeProjectId: "project-worktree",
    },
    { id: "task-one", title: "Duplicate" },
    { title: "No id" },
  ];

  try {
    saveProject(project, databasePath);

    const loaded = loadPersistedState({ databasePath });
    assert.deepEqual(loaded.projects[0]?.ui.pipelineTasks, [
      project.ui.pipelineTasks[0],
    ]);
    assert.deepEqual(
      loaded.projects[0]?.ui.pipelineConfig,
      project.ui.pipelineConfig,
    );
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("legacy kanban cards and view migrate to the pipeline", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  project.ui.workspaceView = "kanban";
  delete project.ui.pipelineTasks;
  project.ui.kanbanCards = [
    {
      chatId: "chat-1",
      column: "inProgress",
      createdAt: timestamp,
      description: "Add a Kanban board",
      id: "card-one",
      title: "Ship kanban",
      updatedAt: timestamp,
    },
    {
      chatId: null,
      column: "ready",
      createdAt: timestamp,
      description: "",
      id: "card-two",
      title: "Write docs",
      updatedAt: timestamp,
    },
    {
      chatId: "chat-3",
      column: "done",
      createdAt: timestamp,
      description: "",
      id: "card-three",
      title: "Shipped",
      updatedAt: timestamp,
    },
  ];

  try {
    saveProject(project, databasePath);

    const loaded = loadPersistedState({ databasePath });
    const ui = loaded.projects[0]?.ui;
    assert.equal(ui?.workspaceView, "pipeline");
    assert.equal(Object.hasOwn(ui ?? {}, "kanbanCards"), false);
    assert.deepEqual(
      ui?.pipelineTasks.map((task) => [task.id, task.step]),
      [
        ["card-one", "build"],
        ["card-two", "backlog"],
        ["card-three", "merge"],
      ],
    );
    assert.deepEqual(ui?.pipelineTasks[0]?.runs, [
      {
        chatId: "chat-1",
        feedback: null,
        finishedAt: null,
        id: "legacy-card-one",
        output: null,
        startedAt: timestamp,
        step: "build",
      },
    ]);
    assert.deepEqual(ui?.pipelineTasks[1]?.runs, []);
    assert.equal(ui?.pipelineTasks[2]?.completion?.kind, "legacy");
    assert.equal(ui?.pipelineTasks[2]?.runs[0]?.finishedAt, timestamp);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});
