#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_PERSISTED_STATE = {
  activeProjectId: null,
  activeChatIdByProject: {},
  chats: [],
  closedProjects: [],
  messagesByChatId: {},
  panelVisibility: {
    left: false,
    middle: true,
    right: true,
  },
  projects: [],
  settings: {
    anthropicAccessToken: "",
    anthropicAccessTokenExpiresAt: null,
    anthropicAuthMode: "apiKey",
    anthropicApiKey: "",
    anthropicRefreshToken: "",
    anthropicSelectedModels: [],
    autoAcceptPermissions: false,
    connectedProviders: [],
    defaultAnthropicModel: "",
    defaultOpenAiModel: "",
    expandToolCalls: false,
    groupToolCalls: false,
    openAiAuthMode: "apiKey",
    openAiApiKey: "",
    openAiSelectedModels: [],
    showReasoningSummaries: true,
    shellPath: "",
  },
  chatSort: "recent",
};

const PERSISTED_STATE_KEY = "ide-state";
const SQLITE_STATE_FILENAME = "dream.sqlite";
const LEGACY_STORE_FILENAME = "dream-settings.json";

const cloneDefaultPersistedState = () =>
  JSON.parse(JSON.stringify(DEFAULT_PERSISTED_STATE));

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseJson = (value, fallback) => {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const getNestedRecord = (parent, key) =>
  isRecord(parent?.[key]) ? parent[key] : {};

const getNestedString = (parent, key, fallback = "") =>
  typeof parent?.[key] === "string" ? parent[key] : fallback;

const getNestedNullableString = (parent, key) =>
  typeof parent?.[key] === "string" && parent[key].trim() ? parent[key] : null;

const getNestedNumber = (parent, key, fallback) =>
  typeof parent?.[key] === "number" && Number.isFinite(parent[key])
    ? parent[key]
    : fallback;

const getNestedBoolean = (parent, key, fallback) =>
  typeof parent?.[key] === "boolean" ? parent[key] : fallback;

const getNestedStringArray = (parent, key) => {
  const value = parent?.[key];
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  return value.flatMap((item) => {
    const stringValue = typeof item === "string" ? item.trim() : "";
    if (!stringValue || seen.has(stringValue)) {
      return [];
    }

    seen.add(stringValue);
    return [stringValue];
  });
};

const getNestedNumberRecord = (parent, key) => {
  const value = parent?.[key];
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([recordKey, recordValue]) =>
        typeof recordKey === "string" &&
        recordKey.trim() &&
        typeof recordValue === "number" &&
        Number.isFinite(recordValue) &&
        recordValue > 0,
    ),
  );
};

const getNestedRightPanelView = (parent, key, fallback = "changes") => {
  const value = parent?.[key];
  return value === "browser" || value === "explorer" || value === "changes"
    ? value
    : fallback;
};

const tableExists = (database, tableName) => {
  const row = database
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        LIMIT 1
      `,
    )
    .get(tableName);

  return typeof row?.name === "string";
};

const readConfig = (database) => {
  if (!tableExists(database, "config")) {
    return {};
  }

  const rows = database.prepare("SELECT key, value FROM config").all();
  return Object.fromEntries(
    rows
      .filter((row) => typeof row?.key === "string")
      .map((row) => [row.key, parseJson(row.value, null)]),
  );
};

const loadRelationalPersistedState = (database) => {
  if (
    !tableExists(database, "projects") ||
    !tableExists(database, "chats") ||
    !tableExists(database, "chat_messages")
  ) {
    return null;
  }

  const config = readConfig(database);
  const projectRows = database
    .prepare("SELECT * FROM projects ORDER BY status = 'closed', sort_order")
    .all();

  if (projectRows.length === 0 && Object.keys(config).length === 0) {
    return null;
  }

  const projects = [];
  const closedProjects = [];
  const activeChatIdByProject = {};

  for (const row of projectRows) {
    const metadata = parseJson(row.metadata, {});
    const icon = getNestedRecord(metadata, "icon");
    const iconPath = getNestedString(icon, "path", "");
    const modelSelection = getNestedRecord(metadata, "modelSelection");
    const browser = getNestedRecord(metadata, "browser");
    const ui = getNestedRecord(metadata, "ui");
    const panelSizes = getNestedRecord(ui, "panelSizes");
    const project = {
      browserUrl: getNestedString(browser, "url", "http://127.0.0.1:3000"),
      id: row.id,
      icon: iconPath
        ? {
            path: iconPath,
            mimeType: getNestedString(
              icon,
              "mimeType",
              "application/octet-stream",
            ),
            source: getNestedString(icon, "source", "unknown"),
            mtimeMs: getNestedNumber(icon, "mtimeMs", 0),
          }
        : null,
      metadata,
      model: getNestedString(modelSelection, "model", ""),
      modelSpeed: getNestedString(modelSelection, "modelSpeed", "standard"),
      name: row.name || path.basename(row.path || "") || "project",
      path: row.path || "",
      provider: getNestedString(modelSelection, "provider", "openai"),
      reasoningEffort: getNestedString(
        modelSelection,
        "reasoningEffort",
        "medium",
      ),
      runCommand: getNestedString(metadata, "runCommand", "pnpm dev"),
      ui: {
        activeChatId: getNestedNullableString(ui, "activeChatId"),
        openChatIds: getNestedStringArray(ui, "openChatIds"),
        chatColumnWidths: getNestedNumberRecord(ui, "chatColumnWidths"),
        chatHistoryPanelOpen: getNestedBoolean(
          ui,
          "chatHistoryPanelOpen",
          false,
        ),
        multiChat: getNestedBoolean(ui, "multiChat", false),
        panelSizes: {
          chatHistoryPanelWidth: getNestedNumber(
            panelSizes,
            "chatHistoryPanelWidth",
            400,
          ),
          leftSidebarWidth: getNestedNumber(
            panelSizes,
            "leftSidebarWidth",
            240,
          ),
          rightPanelWidth: getNestedNumber(panelSizes, "rightPanelWidth", 520),
          terminalHeight: getNestedNumber(panelSizes, "terminalHeight", 260),
        },
        rightPanelOpen: getNestedBoolean(
          getNestedRecord(ui, "panelVisibility"),
          "right",
          true,
        ),
        rightPanelView: getNestedRightPanelView(ui, "rightPanelView"),
      },
    };

    activeChatIdByProject[project.id] = project.ui.activeChatId;
    if (row.status === "closed") {
      closedProjects.push(project);
    } else {
      projects.push(project);
    }
  }

  const chats = database
    .prepare("SELECT * FROM chats ORDER BY created_at, id")
    .all()
    .map((row) => {
      const metadata = parseJson(row.metadata, {});
      const modelSelection = getNestedRecord(metadata, "modelSelection");
      const remoteConversation = getNestedRecord(
        metadata,
        "remoteConversation",
      );

      return {
        createdAt: row.created_at,
        deletedAt:
          typeof row.deleted_at === "string" && row.deleted_at.trim()
            ? row.deleted_at
            : null,
        id: row.id,
        metadata,
        model: getNestedString(modelSelection, "model", ""),
        modelSpeed: getNestedString(modelSelection, "modelSpeed", "standard"),
        projectId: row.project_id,
        provider: getNestedString(modelSelection, "provider", "openai"),
        reasoningEffort: getNestedString(
          modelSelection,
          "reasoningEffort",
          "medium",
        ),
        remoteConversationId: getNestedNullableString(remoteConversation, "id"),
        remoteConversationModel: getNestedNullableString(
          remoteConversation,
          "model",
        ),
        remoteConversationModelSpeed: getNestedNullableString(
          remoteConversation,
          "modelSpeed",
        ),
        remoteConversationProjectPath: getNestedNullableString(
          remoteConversation,
          "projectPath",
        ),
        title: row.title || "New chat",
        updatedAt: row.updated_at,
      };
    });
  const messagesByChatId = Object.fromEntries(
    chats.map((chat) => [chat.id, []]),
  );
  const messageRows = database
    .prepare(
      "SELECT chat_id, payload FROM chat_messages ORDER BY chat_id, sort_order",
    )
    .all();

  for (const row of messageRows) {
    const payload = parseJson(row.payload, null);
    if (isRecord(payload) && Array.isArray(messagesByChatId[row.chat_id])) {
      messagesByChatId[row.chat_id].push(payload);
    }
  }

  return {
    activeProjectId:
      typeof config.activeProjectId === "string"
        ? config.activeProjectId
        : null,
    activeChatIdByProject,
    chats,
    chatSort: typeof config.chatSort === "string" ? config.chatSort : "recent",
    closedProjects,
    messagesByChatId,
    projects,
    settings: {
      ...cloneDefaultPersistedState().settings,
      defaultOpenAiModel:
        typeof config["settings.defaultModel"] === "string"
          ? config["settings.defaultModel"]
          : "",
      openAiSelectedModels: Array.isArray(
        config["settings.openAiSelectedModels"],
      )
        ? config["settings.openAiSelectedModels"]
        : [],
      anthropicSelectedModels: Array.isArray(
        config["settings.anthropicSelectedModels"],
      )
        ? config["settings.anthropicSelectedModels"]
        : [],
      autoAcceptPermissions:
        typeof config["settings.autoAcceptPermissions"] === "boolean"
          ? config["settings.autoAcceptPermissions"]
          : false,
      shellPath:
        typeof config["settings.shellPath"] === "string"
          ? config["settings.shellPath"]
          : "",
      expandToolCalls:
        typeof config["settings.expandToolCalls"] === "boolean"
          ? config["settings.expandToolCalls"]
          : false,
      groupToolCalls:
        typeof config["settings.groupToolCalls"] === "boolean"
          ? config["settings.groupToolCalls"]
          : false,
      showReasoningSummaries:
        typeof config["settings.showReasoningSummaries"] === "boolean"
          ? config["settings.showReasoningSummaries"]
          : true,
    },
  };
};

const parseArgs = (argv) => {
  const options = {
    codexDir: path.join(os.homedir(), ".codex"),
    dryRun: false,
    userDataDir: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--codex-dir") {
      options.codexDir = argv[index + 1] ?? options.codexDir;
      index += 1;
      continue;
    }

    if (arg.startsWith("--codex-dir=")) {
      options.codexDir = arg.slice("--codex-dir=".length);
      continue;
    }

    if (arg === "--user-data-dir") {
      options.userDataDir = argv[index + 1] ?? options.userDataDir;
      index += 1;
      continue;
    }

    if (arg.startsWith("--user-data-dir=")) {
      options.userDataDir = arg.slice("--user-data-dir=".length);
    }
  }

  return options;
};

const getUserDataCandidates = () => {
  const names = ["Dream IDE", "dream", "Electron"];
  const roots = [];

  if (process.platform === "win32") {
    if (process.env.APPDATA) {
      roots.push(process.env.APPDATA);
    }
    if (process.env.LOCALAPPDATA) {
      roots.push(process.env.LOCALAPPDATA);
    }
  } else if (process.platform === "darwin") {
    roots.push(path.join(os.homedir(), "Library", "Application Support"));
  } else {
    roots.push(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    );
  }

  return roots.flatMap((root) => names.map((name) => path.join(root, name)));
};

const resolveUserDataDir = (preferredUserDataDir) => {
  if (preferredUserDataDir?.trim()) {
    return preferredUserDataDir.trim();
  }

  const candidates = getUserDataCandidates();
  const existingCandidate = candidates.find((candidate) => {
    return (
      existsSync(path.join(candidate, SQLITE_STATE_FILENAME)) ||
      existsSync(path.join(candidate, LEGACY_STORE_FILENAME))
    );
  });

  return (
    existingCandidate ?? candidates.at(-1) ?? path.join(os.homedir(), ".dream")
  );
};

const readJsonLines = (filePath) => {
  try {
    const content = readFileSync(filePath, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

const collectJsonlFiles = (directory) => {
  if (!existsSync(directory)) {
    return [];
  }

  const files = [];
  const stack = [directory];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  return files;
};

const normalizePathKey = (value) =>
  typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;

const getDefaultImportedModel = (provider, settings) => {
  if (provider === "anthropic") {
    return (
      settings.defaultAnthropicModel ||
      settings.anthropicSelectedModels?.[0] ||
      ""
    );
  }

  return (
    settings.defaultOpenAiModel || settings.openAiSelectedModels?.[0] || ""
  );
};

const inferChatTitle = (titleFromIndex, messages, sessionId) => {
  if (typeof titleFromIndex === "string" && titleFromIndex.trim()) {
    return titleFromIndex.trim();
  }

  const firstUserMessage = messages.find((message) => message.role === "user");
  const text = firstUserMessage?.parts?.[0]?.text;
  if (typeof text === "string" && text.trim()) {
    return text.trim().replace(/\s+/g, " ").slice(0, 60);
  }

  return `Imported ${sessionId}`;
};

const createImportedMessage = (sessionId, role, index, text) => {
  const trimmed = typeof text === "string" ? text.trimEnd() : "";
  if (!trimmed) {
    return null;
  }

  return {
    id: `codex-${sessionId}-${role}-${index}`,
    parts:
      role === "assistant"
        ? [
            { type: "step-start" },
            {
              state: "done",
              text: trimmed,
              type: "text",
            },
          ]
        : [
            {
              text: trimmed,
              type: "text",
            },
          ],
    role,
  };
};

const loadPersistedState = (userDataDir) => {
  const databasePath = path.join(userDataDir, SQLITE_STATE_FILENAME);
  if (existsSync(databasePath)) {
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const row = database
      .prepare("SELECT value FROM app_state WHERE key = ?")
      .get(PERSISTED_STATE_KEY);

    if (typeof row?.value === "string" && row.value.trim()) {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed && typeof parsed === "object") {
          database.close();
          return parsed;
        }
      } catch {
        // fall through to legacy/default state
      }
    }

    const relationalState = loadRelationalPersistedState(database);
    database.close();
    if (relationalState) {
      return relationalState;
    }
  }

  const legacyStorePath = path.join(userDataDir, LEGACY_STORE_FILENAME);
  if (existsSync(legacyStorePath)) {
    try {
      const parsed = JSON.parse(readFileSync(legacyStorePath, "utf8"));
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // ignore invalid legacy state and use defaults
    }
  }

  return cloneDefaultPersistedState();
};

const savePersistedState = (userDataDir, state) => {
  mkdirSync(userDataDir, { recursive: true });
  const databasePath = path.join(userDataDir, SQLITE_STATE_FILENAME);
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  database
    .prepare(
      `
        INSERT INTO app_state (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
    )
    .run(PERSISTED_STATE_KEY, JSON.stringify(state), new Date().toISOString());
  database.close();
};

const importCodexChatsIntoState = (currentState, codexRoot) => {
  const sessionIndexPath = path.join(codexRoot, "session_index.jsonl");
  const sessionIndex = new Map();

  for (const entry of readJsonLines(sessionIndexPath)) {
    const id = entry?.id?.trim?.();
    if (!id) {
      continue;
    }

    sessionIndex.set(id, {
      title: entry?.thread_name?.trim?.() ?? "",
      updatedAt: entry?.updated_at?.trim?.() ?? "",
    });
  }

  const sessionFiles = [
    ...collectJsonlFiles(path.join(codexRoot, "sessions")),
    ...collectJsonlFiles(path.join(codexRoot, "archived_sessions")),
  ];

  const nextState = {
    ...currentState,
    activeChatIdByProject: {
      ...(currentState.activeChatIdByProject ??
        currentState.activeThreadIdByProject ??
        {}),
    },
    chats: [...(currentState.chats ?? currentState.threads ?? [])],
    messagesByChatId: {
      ...(currentState.messagesByChatId ?? currentState.chats ?? {}),
    },
    closedProjects: [...(currentState.closedProjects ?? [])],
    projects: [...(currentState.projects ?? [])],
  };

  const knownProjects = [...nextState.projects, ...nextState.closedProjects];
  const projectIdsByPath = new Map(
    knownProjects.flatMap((project) => {
      const pathKey = normalizePathKey(project?.path);
      const projectId =
        typeof project?.id === "string" && project.id.trim()
          ? project.id
          : null;

      return pathKey && projectId ? [[pathKey, projectId]] : [];
    }),
  );
  const chatIds = new Set(
    nextState.chats.flatMap((chat) =>
      typeof chat?.id === "string" && chat.id.trim() ? [chat.id] : [],
    ),
  );
  const remoteConversationIds = new Set(
    nextState.chats.flatMap((chat) =>
      typeof chat?.remoteConversationId === "string" &&
      chat.remoteConversationId.trim()
        ? [chat.remoteConversationId]
        : [],
    ),
  );

  const result = {
    importedMessages: 0,
    importedChats: 0,
    projectsCreated: 0,
    skippedChats: 0,
  };

  for (const filePath of sessionFiles) {
    const entries = readJsonLines(filePath);
    if (entries.length === 0) {
      continue;
    }

    const metaEntry = entries.find((entry) => entry?.type === "session_meta");
    const payload = metaEntry?.payload ?? {};
    const sessionId =
      typeof payload.id === "string" && payload.id.trim()
        ? payload.id.trim()
        : "";

    if (!sessionId) {
      result.skippedChats += 1;
      continue;
    }

    const chatId = `codex-${sessionId}`;
    if (chatIds.has(chatId) || remoteConversationIds.has(sessionId)) {
      result.skippedChats += 1;
      continue;
    }

    const cwd =
      typeof payload.cwd === "string" && payload.cwd.trim()
        ? payload.cwd.trim()
        : path.join(codexRoot, "imported");
    const provider =
      payload.model_provider === "anthropic" ? "anthropic" : "openai";

    const importedMessages = [];
    let userIndex = 0;
    let assistantIndex = 0;

    for (const entry of entries) {
      if (entry?.type !== "event_msg" || !entry.payload) {
        continue;
      }

      if (entry.payload.type === "user_message") {
        const message = createImportedMessage(
          sessionId,
          "user",
          userIndex,
          entry.payload.message,
        );
        userIndex += 1;
        if (message) {
          importedMessages.push(message);
        }
        continue;
      }

      if (entry.payload.type === "agent_message") {
        const message = createImportedMessage(
          sessionId,
          "assistant",
          assistantIndex,
          entry.payload.message,
        );
        assistantIndex += 1;
        if (message) {
          importedMessages.push(message);
        }
      }
    }

    if (importedMessages.length === 0) {
      result.skippedChats += 1;
      continue;
    }

    const pathKey = normalizePathKey(cwd);
    let projectId = pathKey ? (projectIdsByPath.get(pathKey) ?? null) : null;
    if (!projectId) {
      projectId = randomUUID();
      nextState.projects.push({
        id: projectId,
        model: getDefaultImportedModel(provider, nextState.settings ?? {}),
        name: path.basename(cwd) || "Imported Codex Chats",
        path: cwd,
        browserUrl: "http://127.0.0.1:3000",
        provider,
        reasoningEffort: "medium",
        runCommand: "pnpm dev",
      });
      if (pathKey) {
        projectIdsByPath.set(pathKey, projectId);
      }
      if (!(projectId in nextState.activeChatIdByProject)) {
        nextState.activeChatIdByProject[projectId] = null;
      }
      result.projectsCreated += 1;
    }

    const indexedMeta = sessionIndex.get(sessionId);
    const createdAt =
      typeof payload.timestamp === "string" && payload.timestamp.trim()
        ? payload.timestamp.trim()
        : new Date().toISOString();
    const updatedAt =
      indexedMeta?.updatedAt || entries.at(-1)?.timestamp || createdAt;

    nextState.chats.unshift({
      archivedAt: null,
      createdAt,
      id: chatId,
      model: getDefaultImportedModel(provider, nextState.settings ?? {}),
      projectId,
      provider,
      reasoningEffort: "medium",
      remoteConversationId: sessionId,
      remoteConversationModel: null,
      remoteConversationProjectPath: cwd,
      title: inferChatTitle(indexedMeta?.title, importedMessages, sessionId),
      updatedAt,
    });
    nextState.messagesByChatId[chatId] = importedMessages;
    chatIds.add(chatId);
    remoteConversationIds.add(sessionId);
    result.importedMessages += importedMessages.length;
    result.importedChats += 1;

    if (!nextState.activeChatIdByProject[projectId]) {
      nextState.activeChatIdByProject[projectId] = chatId;
    }
  }

  return { nextState, result };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const userDataDir = resolveUserDataDir(options.userDataDir);
  const state = loadPersistedState(userDataDir);
  const { nextState, result } = importCodexChatsIntoState(
    state,
    options.codexDir,
  );

  console.log(`Using user data dir: ${userDataDir}`);
  console.log(`Using Codex dir: ${options.codexDir}`);

  if (options.dryRun) {
    console.log("Dry run enabled. No state was written.");
  } else if (result.importedChats > 0) {
    savePersistedState(userDataDir, nextState);
  }

  console.log(
    `Imported ${result.importedChats} chat(s) and ${result.importedMessages} message(s).`,
  );
  console.log(
    `Created ${result.projectsCreated} project(s), skipped ${result.skippedChats} chat(s).`,
  );
};

main();
