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
    tasks: [],
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

/**
 * Rewinds a saved database to the pre-`appView` shape: the view lived in each
 * project's `metadata.ui.workspaceView` and no app-level key existed.
 */
const downgradeToLegacyWorkspaceView = (databasePath, projectId, view) => {
  const database = getPersistedStateDatabase({ databasePath });
  const row = database
    .prepare("SELECT metadata FROM projects WHERE id = ?")
    .get(projectId);
  const metadata = JSON.parse(row.metadata);
  metadata.ui = { ...metadata.ui, workspaceView: view };
  database
    .prepare("UPDATE projects SET metadata = ? WHERE id = ?")
    .run(JSON.stringify(metadata), projectId);
  database
    .prepare("DELETE FROM config WHERE key IN ('appView', 'tasksProjectId')")
    .run();
};

test("app view and Tasks project filter survive a relational persistence round trip", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const project = createProject("project-one", "2026-08-15T12:00:00.000Z");

  try {
    savePersistedState(
      createState(project, {
        appView: "tasks",
        tasksProjectId: project.id,
      }),
      { databasePath },
    );

    const loaded = loadPersistedState({ databasePath });
    assert.equal(loaded.appView, "tasks");
    assert.equal(loaded.tasksProjectId, project.id);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("app view and Tasks project filter fall back when missing or invalid", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const project = createProject("project-one", "2026-08-15T12:00:00.000Z");

  try {
    savePersistedState(
      createState(project, {
        appView: "not-a-view",
        tasksProjectId: 42,
      }),
      { databasePath },
    );

    const loaded = loadPersistedState({ databasePath });
    assert.equal(loaded.appView, "code");
    assert.equal(loaded.tasksProjectId, null);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("the active project's legacy workspace view seeds the app view once", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const active = createProject("project-active", timestamp);
  const other = createProject("project-other", timestamp);

  try {
    for (const [activeView, otherView, expected] of [
      ["pipeline", "code", "tasks"],
      // "kanban" is the Tasks workspace's retired name.
      ["kanban", "code", "tasks"],
      // Only the active project's choice carries over.
      ["code", "pipeline", "code"],
      ["not-a-workspace", "code", "code"],
    ]) {
      savePersistedState(createState(active, { projects: [active, other] }), {
        databasePath,
      });
      downgradeToLegacyWorkspaceView(databasePath, active.id, activeView);
      downgradeToLegacyWorkspaceView(databasePath, other.id, otherView);

      const loaded = loadPersistedState({ databasePath });
      assert.equal(loaded.appView, expected, `${activeView}/${otherView}`);
      assert.equal(loaded.tasksProjectId, null);
      assert.equal(
        Object.hasOwn(loaded.projects[0].ui, "workspaceView"),
        false,
      );
    }

    // Saving writes the app-level key and retires the per-project one, so a
    // later switch back to Code is not overridden by the stale legacy value.
    savePersistedState(createState(active, { projects: [active, other] }), {
      databasePath,
    });
    downgradeToLegacyWorkspaceView(databasePath, active.id, "pipeline");
    const upgraded = loadPersistedState({ databasePath });
    savePersistedState({ ...upgraded, appView: "code" }, { databasePath });

    const database = getPersistedStateDatabase({ databasePath });
    const { metadata } = database
      .prepare("SELECT metadata FROM projects WHERE id = ?")
      .get(active.id);
    assert.equal(
      Object.hasOwn(JSON.parse(metadata).ui, "workspaceView"),
      false,
    );
    assert.equal(loadPersistedState({ databasePath }).appView, "code");
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

const saveProject = (project, databasePath, overrides = {}) =>
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
      ...overrides,
    },
    { databasePath },
  );

test("tasks and step config survive a relational persistence round trip", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  // One app-wide config, saved beside the projects rather than on them.
  const taskConfig = {
    build: {
      agentMode: "build",
      autoAdvance: false,
      model: null,
      permissionMode: "full-access",
      prompt: "Custom build prompt",
    },
  };
  project.ui.tasks = [
    {
      baseRef: "main",
      branch: "task/ship-it",
      completion: null,
      createdAt: timestamp,
      description: "Add a task board",
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
      title: "Ship tasks",
      updatedAt: timestamp,
      worktreePath: "/workspace/ship-it",
      worktreeProjectId: "project-worktree",
    },
    { id: "task-one", title: "Duplicate" },
    { title: "No id" },
  ];

  try {
    saveProject(project, databasePath, { taskConfig });

    // A state from before tasks were app-wide still carries them on the
    // project; saving it moves them to the tasks table.
    const loaded = loadPersistedState({ databasePath });
    assert.deepEqual(loaded.tasks, [
      { ...project.ui.tasks[0], projectId: project.id },
    ]);
    assert.equal(Object.hasOwn(loaded.projects[0]?.ui ?? {}, "tasks"), false);
    const database = getPersistedStateDatabase({ databasePath });
    assert.equal(
      Object.hasOwn(
        JSON.parse(
          database
            .prepare("SELECT metadata FROM projects WHERE id = ?")
            .get(project.id).metadata,
        ).ui,
        "tasks",
      ),
      false,
    );
    assert.deepEqual(loaded.taskConfig, taskConfig);
    assert.deepEqual(loaded.projects[0]?.ui.taskConfig, {});
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

const createStoredTask = (id, projectId, timestamp, overrides = {}) => ({
  baseRef: null,
  branch: null,
  completion: null,
  createdAt: timestamp,
  description: "",
  id,
  projectId,
  runs: [],
  step: "backlog",
  title: id,
  updatedAt: timestamp,
  worktreePath: null,
  worktreeProjectId: null,
  ...overrides,
});

test("app-wide tasks keep their order and belong to open or closed projects", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const openProject = createProject("project-open", timestamp);
  const closedProject = createProject("project-closed", timestamp);
  delete openProject.ui.tasks;
  delete closedProject.ui.tasks;
  const tasks = [
    createStoredTask("task-b", closedProject.id, timestamp),
    createStoredTask("task-a", openProject.id, timestamp, { step: "build" }),
    createStoredTask("task-c", closedProject.id, timestamp),
  ];
  const state = {
    activeProjectId: openProject.id,
    chats: [],
    closedProjects: [closedProject],
    messagesByChatId: {},
    projects: [openProject],
    settings: {},
    tasks: [
      ...tasks,
      createStoredTask("task-a", openProject.id, timestamp, {
        title: "Duplicate id",
      }),
      createStoredTask("task-orphan", "project-gone", timestamp),
    ],
  };

  try {
    savePersistedState(state, { databasePath });
    assert.deepEqual(loadPersistedState({ databasePath }).tasks, tasks);

    // Reordering and deleting are both just the next snapshot.
    const reordered = [tasks[2], tasks[0]];
    savePersistedState({ ...state, tasks: reordered }, { databasePath });
    assert.deepEqual(loadPersistedState({ databasePath }).tasks, reordered);

    // A state that says nothing about tasks leaves them alone.
    const { tasks: _tasks, ...stateWithoutTasks } = state;
    savePersistedState(stateWithoutTasks, { databasePath });
    assert.deepEqual(loadPersistedState({ databasePath }).tasks, reordered);

    // A removed project takes its tasks with it.
    savePersistedState(
      { ...state, closedProjects: [], tasks: [...reordered, tasks[1]] },
      { databasePath },
    );
    assert.deepEqual(loadPersistedState({ databasePath }).tasks, [tasks[1]]);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("tasks stored on several projects merge into one list without id clashes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const first = createProject("project-one", timestamp);
  const second = createProject("project-two", timestamp);
  // Task ids used to be unique only within a project.
  first.ui.tasks = [{ id: "task-one", step: "backlog", title: "First" }];
  second.ui.tasks = [{ id: "task-one", step: "backlog", title: "Second" }];

  try {
    savePersistedState(
      {
        activeProjectId: first.id,
        chats: [],
        closedProjects: [second],
        messagesByChatId: {},
        projects: [first],
        settings: {},
      },
      { databasePath },
    );

    const loaded = loadPersistedState({ databasePath }).tasks;
    assert.deepEqual(
      loaded.map((task) => [task.title, task.projectId]),
      [
        ["First", first.id],
        ["Second", second.id],
      ],
    );
    assert.equal(loaded[0]?.id, "task-one");
    assert.notEqual(loaded[1]?.id, "task-one");
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("data saved under the workspace's old pipeline name still loads", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  const task = {
    branch: "pipeline/ship-it",
    completion: null,
    createdAt: timestamp,
    description: "",
    id: "task-one",
    runs: [],
    step: "backlog",
    title: "Ship it",
    updatedAt: timestamp,
  };
  const stepConfig = { plan: { autoAdvance: true } };

  try {
    saveProject(project, databasePath);

    // Rewind to the pre-rename shape: `pipeline*` keys everywhere.
    const database = getPersistedStateDatabase({ databasePath });
    const row = database
      .prepare("SELECT metadata FROM projects WHERE id = ?")
      .get(project.id);
    const metadata = JSON.parse(row.metadata);
    delete metadata.ui.tasks;
    delete metadata.ui.taskConfig;
    metadata.ui.pipelineTasks = [task];
    metadata.ui.pipelineConfig = stepConfig;
    database
      .prepare("UPDATE projects SET metadata = ? WHERE id = ?")
      .run(JSON.stringify(metadata), project.id);
    database
      .prepare("DELETE FROM config WHERE key IN ('appView', 'tasksProjectId')")
      .run();
    const insertConfig = database.prepare(
      "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)",
    );
    insertConfig.run("appView", JSON.stringify("pipeline"), timestamp);
    insertConfig.run(
      "pipelineProjectId",
      JSON.stringify(project.id),
      timestamp,
    );

    const loaded = loadPersistedState({ databasePath });
    assert.equal(loaded.appView, "tasks");
    assert.equal(loaded.tasksProjectId, project.id);
    const migratedTask = { ...task, projectId: project.id };
    assert.deepEqual(loaded.tasks, [migratedTask]);
    // Legacy per-project step settings are passed through for the renderer to
    // seed the app-wide config from; none has been saved yet.
    assert.deepEqual(loaded.projects[0]?.ui.taskConfig, stepConfig);
    assert.equal(loaded.taskConfig, null);

    // The next save moves the data to the new keys and drops the old ones.
    savePersistedState({ ...loaded, taskConfig: stepConfig }, { databasePath });
    const saved = JSON.parse(
      database
        .prepare("SELECT metadata FROM projects WHERE id = ?")
        .get(project.id).metadata,
    ).ui;
    // Tasks left the project for their own table.
    assert.equal(Object.hasOwn(saved, "tasks"), false);
    assert.equal(Object.hasOwn(saved, "pipelineTasks"), false);
    assert.deepEqual(
      database
        .prepare("SELECT id, project_id FROM tasks")
        .all()
        .map((row) => [row.id, row.project_id]),
      [[task.id, project.id]],
    );
    // Step settings moved to the app level and left the project.
    assert.equal(Object.hasOwn(saved, "pipelineConfig"), false);
    assert.equal(Object.hasOwn(saved, "taskConfig"), false);
    assert.deepEqual(
      loadPersistedState({ databasePath }).taskConfig,
      stepConfig,
    );
    assert.deepEqual(loadPersistedState({ databasePath }).tasks, [
      migratedTask,
    ]);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("legacy kanban cards migrate to tasks", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  delete project.ui.tasks;
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
    const tasks = loaded.tasks;
    assert.equal(Object.hasOwn(ui ?? {}, "kanbanCards"), false);
    assert.deepEqual(
      tasks.map((task) => task.projectId),
      [project.id, project.id, project.id],
    );
    assert.deepEqual(
      tasks.map((task) => [task.id, task.step]),
      [
        ["card-one", "build"],
        ["card-two", "backlog"],
        ["card-three", "merge"],
      ],
    );
    assert.deepEqual(tasks[0]?.runs, [
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
    assert.deepEqual(tasks[1]?.runs, []);
    assert.equal(tasks[2]?.completion?.kind, "legacy");
    assert.equal(tasks[2]?.runs[0]?.finishedAt, timestamp);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
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
  taskId: null,
  title: id,
  updatedAt: timestamp,
  ...overrides,
});

test("chats remember their task, and older chats are claimed by their task's runs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  const state = {
    ...createState(project),
    chats: [
      createStoredChat("owned", project.id, timestamp, { taskId: "task-one" }),
      // Saved before chats knew their task; its task's run points at it.
      createStoredChat("legacy", project.id, timestamp),
      createStoredChat("plain", project.id, timestamp),
    ],
    tasks: [
      createStoredTask("task-one", project.id, timestamp, {
        runs: [
          {
            chatId: "legacy",
            commitError: null,
            feedback: null,
            finishedAt: null,
            id: "run-1",
            output: null,
            startedAt: timestamp,
            step: "plan",
          },
        ],
        step: "plan",
      }),
    ],
  };

  try {
    savePersistedState(state, { databasePath });
    const loaded = loadPersistedState({ databasePath });
    const byId = new Map(loaded.chats.map((chat) => [chat.id, chat.taskId]));
    assert.equal(byId.get("owned"), "task-one");
    assert.equal(byId.get("legacy"), "task-one");
    assert.equal(byId.get("plain"), null);

    // The claimed link is written on the next save.
    savePersistedState({ ...state, chats: loaded.chats }, { databasePath });
    const database = getPersistedStateDatabase({ databasePath });
    assert.equal(
      database.prepare("SELECT task_id FROM chats WHERE id = ?").get("legacy")
        .task_id,
      "task-one",
    );
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});

test("step chats and transcripts survive removing the task's worktree", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-state-test-"));
  const databasePath = path.join(directory, "state.db");
  const timestamp = "2026-08-15T12:00:00.000Z";
  const project = createProject("project-one", timestamp);
  const worktree = createProject("project-one-worktree", timestamp);
  const message = {
    id: "step-message",
    parts: [{ text: "build it", type: "text" }],
    role: "user",
  };
  const task = createStoredTask("task-one", project.id, timestamp, {
    runs: [
      {
        chatId: "step-chat",
        commitError: null,
        feedback: null,
        finishedAt: timestamp,
        id: "run-1",
        output: null,
        startedAt: timestamp,
        step: "build",
      },
    ],
    step: "build",
    worktreeProjectId: worktree.id,
  });

  try {
    savePersistedState(
      createState(project, {
        chats: [
          createStoredChat("step-chat", worktree.id, timestamp, {
            taskId: task.id,
          }),
        ],
        messagesByChatId: { "step-chat": [message] },
        projects: [project, worktree],
        tasks: [task],
      }),
      { databasePath },
    );

    // Removing the worktree hands the chat to the task's own project and
    // drops the worktree project. The transcript is not loaded, so this save
    // carries no messages for it.
    savePersistedState(
      createState(project, {
        chats: [
          createStoredChat("step-chat", project.id, timestamp, {
            taskId: task.id,
          }),
        ],
        tasks: [task],
      }),
      { databasePath },
    );

    const loaded = loadPersistedState({ databasePath });
    assert.deepEqual(
      loaded.chats.map((chat) => [chat.id, chat.projectId]),
      [["step-chat", project.id]],
    );
    assert.deepEqual(
      loadPersistedChatMessages("step-chat", { databasePath }),
      [message],
      "moving the chat must not cascade away its transcript",
    );

    // The same holds when the chat's new project is first saved in the very
    // save that drops its old one.
    const successor = createProject("project-two", timestamp);
    savePersistedState(
      createState(successor, {
        chats: [
          createStoredChat("step-chat", successor.id, timestamp, {
            taskId: task.id,
          }),
        ],
        projects: [successor],
      }),
      { databasePath },
    );
    assert.deepEqual(loadPersistedChatMessages("step-chat", { databasePath }), [
      message,
    ]);
  } finally {
    closePersistedStateDatabase();
    await rm(directory, { force: true, recursive: true });
  }
});
