#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_PERSISTED_STATE = {
  activeProjectId: null,
  activeThreadIdByProject: {},
  chats: {},
  panelVisibility: {
    left: true,
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
    connectedProviders: [],
    defaultAnthropicModel: "",
    defaultOpenAiModel: "",
    openAiAuthMode: "apiKey",
    openAiApiKey: "",
    openAiSelectedModels: [],
    shellPath: "",
  },
  threadSort: "recent",
  threads: [],
};

const PERSISTED_STATE_KEY = "ide-state";
const SQLITE_STATE_FILENAME = "dream.sqlite";
const LEGACY_STORE_FILENAME = "dream-settings.json";

const cloneDefaultPersistedState = () =>
  JSON.parse(JSON.stringify(DEFAULT_PERSISTED_STATE));

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

const inferThreadTitle = (titleFromIndex, messages, sessionId) => {
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
    database.close();

    if (typeof row?.value === "string" && row.value.trim()) {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed && typeof parsed === "object") {
          return parsed;
        }
      } catch {
        // fall through to legacy/default state
      }
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

const importCodexThreadsIntoState = (currentState, codexRoot) => {
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
    activeThreadIdByProject: {
      ...(currentState.activeThreadIdByProject ?? {}),
    },
    chats: { ...(currentState.chats ?? {}) },
    projects: [...(currentState.projects ?? [])],
    threads: [...(currentState.threads ?? [])],
  };

  const projectIdsByPath = new Map(
    nextState.projects.flatMap((project) => {
      const pathKey = normalizePathKey(project?.path);
      const projectId =
        typeof project?.id === "string" && project.id.trim()
          ? project.id
          : null;

      return pathKey && projectId ? [[pathKey, projectId]] : [];
    }),
  );
  const threadIds = new Set(
    nextState.threads.flatMap((thread) =>
      typeof thread?.id === "string" && thread.id.trim() ? [thread.id] : [],
    ),
  );
  const remoteConversationIds = new Set(
    nextState.threads.flatMap((thread) =>
      typeof thread?.remoteConversationId === "string" &&
      thread.remoteConversationId.trim()
        ? [thread.remoteConversationId]
        : [],
    ),
  );

  const result = {
    importedMessages: 0,
    importedThreads: 0,
    projectsCreated: 0,
    skippedThreads: 0,
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
      result.skippedThreads += 1;
      continue;
    }

    const threadId = `codex-${sessionId}`;
    if (threadIds.has(threadId) || remoteConversationIds.has(sessionId)) {
      result.skippedThreads += 1;
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
      result.skippedThreads += 1;
      continue;
    }

    const pathKey = normalizePathKey(cwd);
    let projectId = pathKey ? (projectIdsByPath.get(pathKey) ?? null) : null;
    if (!projectId) {
      projectId = randomUUID();
      nextState.projects.push({
        id: projectId,
        model: getDefaultImportedModel(provider, nextState.settings ?? {}),
        name: path.basename(cwd) || "Imported Codex Threads",
        path: cwd,
        previewUrl: "http://127.0.0.1:3000",
        provider,
        reasoningEffort: "medium",
        runCommand: "pnpm dev",
      });
      if (pathKey) {
        projectIdsByPath.set(pathKey, projectId);
      }
      if (!(projectId in nextState.activeThreadIdByProject)) {
        nextState.activeThreadIdByProject[projectId] = null;
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

    nextState.threads.unshift({
      archivedAt: null,
      createdAt,
      id: threadId,
      model: getDefaultImportedModel(provider, nextState.settings ?? {}),
      projectId,
      provider,
      reasoningEffort: "medium",
      remoteConversationId: sessionId,
      title: inferThreadTitle(indexedMeta?.title, importedMessages, sessionId),
      updatedAt,
    });
    nextState.chats[threadId] = importedMessages;
    threadIds.add(threadId);
    remoteConversationIds.add(sessionId);
    result.importedMessages += importedMessages.length;
    result.importedThreads += 1;

    if (!nextState.activeThreadIdByProject[projectId]) {
      nextState.activeThreadIdByProject[projectId] = threadId;
    }
  }

  return { nextState, result };
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  const userDataDir = resolveUserDataDir(options.userDataDir);
  const state = loadPersistedState(userDataDir);
  const { nextState, result } = importCodexThreadsIntoState(
    state,
    options.codexDir,
  );

  console.log(`Using user data dir: ${userDataDir}`);
  console.log(`Using Codex dir: ${options.codexDir}`);

  if (options.dryRun) {
    console.log("Dry run enabled. No state was written.");
  } else if (result.importedThreads > 0) {
    savePersistedState(userDataDir, nextState);
  }

  console.log(
    `Imported ${result.importedThreads} thread(s) and ${result.importedMessages} message(s).`,
  );
  console.log(
    `Created ${result.projectsCreated} project(s), skipped ${result.skippedThreads} thread(s).`,
  );
};

main();
