// @ts-check
// The persisted-state codec.
//
// One module, used by the renderer and the main process, that owns the shape
// of everything Dream persists: the defaults, how a raw value read from disk
// (or from an older version of the app) is repaired into a valid
// `PersistedIdeState`, how live store state is trimmed down to what deserves
// to be saved, and how projects, chats and settings map to database rows.
//
// The rules used to be written twice, once per side of the renderer <-> main
// IPC seam, and drifted. Now a persisted field is added here, once:
//
//   decodePersistedState   raw (rows, IPC payload, legacy blob) -> valid state
//   encodePersistedState   live store state -> what gets saved
//   projectToRow/FromRow   ProjectConfig  <-> projects row + metadata blob
//   chatToRow/FromRow      ChatConfig     <-> chats row + metadata blob
//   stateToConfig/FromConfig  top-level fields and settings <-> config rows
//
// It has no dependency on Electron, Node or the DOM, so it runs unchanged in
// the renderer bundle, the main process and the save worker.

import { normalizeMcpServerList } from "../api/chat/mcp-servers.js";
import { normalizeChatPermissionMode } from "./chat-permissions.js";
import { normalizeLocalePreference } from "./locales.js";
import {
  ALL_PROVIDERS,
  dedupeModels,
  getDefaultModelSelection,
  getPreferredDefaultModel,
  normalizeClaudeCodeModelId,
  normalizeDefaultModelSettings,
  normalizeModelSpeed,
  normalizeProvider,
  normalizeReasoningEffort,
} from "./model-selection.js";
import {
  DEFAULT_SPARKLES_PALETTE,
  normalizeSparklesPaletteName,
} from "./sparkles-palettes.js";

/** @typedef {import("../../src/types/ide").AppSettings} AppSettings */
/** @typedef {import("../../src/types/ide").AppView} AppView */
/** @typedef {import("../../src/types/ide").BrowserTabState} BrowserTabState */
/** @typedef {import("../../src/types/ide").ChatConfig} ChatConfig */
/** @typedef {import("../../src/types/ide").ChatPermissionMode} ChatPermissionMode */
/** @typedef {import("../../src/types/ide").ChatSortOrder} ChatSortOrder */
/** @typedef {import("../../src/types/ide").PanelSizes} PanelSizes */
/** @typedef {import("../../src/types/ide").PanelVisibility} PanelVisibility */
/** @typedef {import("../../src/types/ide").PersistedIdeState} PersistedIdeState */
/** @typedef {import("../../src/types/ide").ProjectConfig} ProjectConfig */
/** @typedef {import("../../src/types/ide").ProjectReference} ProjectReference */
/** @typedef {import("../../src/types/ide").ProjectUiState} ProjectUiState */
/** @typedef {import("../../src/types/ide").ProjectWorktreeInfo} ProjectWorktreeInfo */
/** @typedef {import("../../src/types/ide").RightPanelView} RightPanelView */
/** @typedef {import("../../src/types/ide").SavedPrompt} SavedPrompt */
/** @typedef {import("../../src/types/ide").StashItem} StashItem */
/** @typedef {import("ai").UIMessage} UIMessage */
/** @typedef {Record<string, unknown>} UnknownRecord */

// ── Defaults ──────────────────────────────────────────────────────────

export const APP_VIEWS = /** @type {const} */ (["code"]);

/** @type {AppView} */
export const DEFAULT_APP_VIEW = "code";

/** @type {AppSettings} */
export const DEFAULT_SETTINGS = {
  archiveChatsAfterDays: 30,
  autoCompactContext: true,
  anthropicSelectedModels: [],
  defaultGitGenerationModel: "",
  defaultGitGenerationModelSpeed: "standard",
  // Commit messages and PR text are short; low effort keeps them fast.
  defaultGitGenerationReasoningEffort: "low",
  defaultModel: "",
  defaultModelSpeed: "standard",
  defaultPermissionMode: "full-access",
  defaultReasoningEffort: null,
  disabledProviders: [],
  changeCheckpoints: true,
  expandToolCalls: false,
  groupToolCalls: false,
  cursorSelectedModels: [],
  grokSelectedModels: [],
  locale: "en",
  mcpServers: [],
  openAiSelectedModels: [],
  openCodeSelectedModels: [],
  showReasoningSummaries: true,
  shellPath: "",
};

/** @type {PanelVisibility} */
export const DEFAULT_PANEL_VISIBILITY = {
  left: false,
  middle: true,
  right: true,
};

/** @type {PanelSizes} */
export const DEFAULT_PANEL_SIZES = {
  chatHistoryPanelWidth: 400,
  gitLogPanelWidth: 400,
  leftSidebarWidth: 240,
  rightPanelWidth: 520,
  terminalHeight: 260,
};

/** @type {ProjectUiState} */
export const DEFAULT_PROJECT_UI = {
  activeChatId: null,
  openChatIds: [],
  chatColumnWidths: {},
  chatHistoryPanelOpen: false,
  changesDiffWordWrap: false,
  fileEditorWordWrap: false,
  multiChat: false,
  panelSizes: DEFAULT_PANEL_SIZES,
  rightPanelOpen: DEFAULT_PANEL_VISIBILITY.right,
  rightPanelView: "changes",
  stashItems: [],
};

/** @returns {PersistedIdeState} */
export const createEmptyPersistedState = () => ({
  activeProjectId: null,
  appView: DEFAULT_APP_VIEW,
  savedPrompts: [],
  activeBrowserTabIdByProject: {},
  browserTabsByProject: {},
  chats: [],
  chatSort: "recent",
  closedProjects: [],
  messagesByChatId: {},
  projects: [],
  settings: { ...DEFAULT_SETTINGS },
});

// ── Small readers over unknown input ──────────────────────────────────

/**
 * @param {unknown} value
 * @returns {value is UnknownRecord}
 */
const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {unknown} value
 * @returns {UnknownRecord}
 */
const asRecord = (value) => (isRecord(value) ? value : {});

/**
 * @param {unknown} value
 * @param {string} [fallback]
 * @returns {string}
 */
const asString = (value, fallback = "") =>
  typeof value === "string" ? value : fallback;

/**
 * A non-empty, trimmed string or `null`.
 * @param {unknown} value
 * @returns {string | null}
 */
const asNullableString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
const asBoolean = (value, fallback) =>
  typeof value === "boolean" ? value : fallback;

/**
 * @param {unknown} value
 * @returns {string | null}
 */
const asTimestamp = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed && Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
};

/**
 * @param {unknown} value
 * @returns {string[]}
 */
const asStringArray = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];

/**
 * Unique, trimmed, non-empty strings in first-seen order.
 * @param {unknown} value
 * @returns {string[]}
 */
const asIdList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();
  /** @type {string[]} */
  const ids = [];
  for (const item of value) {
    const id = typeof item === "string" ? item.trim() : "";
    if (!id || seen.has(id)) {
      continue;
    }

    seen.add(id);
    ids.push(id);
  }

  return ids;
};

/**
 * @param {string} projectPath
 * @returns {string}
 */
const getProjectName = (projectPath) =>
  projectPath.split(/[\\/]/).filter(Boolean).pop() ?? "project";

/**
 * The key two paths share when they name the same directory. Windows paths
 * compare case-insensitively with forward slashes.
 * @param {string} projectPath
 * @returns {string}
 */
export const normalizeProjectPathKey = (projectPath) => {
  const trimmed = projectPath.trim();
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, "") || trimmed;
  const normalized = withoutTrailingSeparators.replace(/\\/g, "/");
  const isWindowsPath =
    /^[a-zA-Z]:\//.test(normalized) || projectPath.includes("\\");

  return isWindowsPath ? normalized.toLowerCase() : normalized;
};

// ── Field normalizers ─────────────────────────────────────────────────

/**
 * @param {unknown} value
 * @returns {AppView | null}
 */
export const normalizeAppView = (value) =>
  typeof value === "string" &&
  /** @type {readonly string[]} */ (APP_VIEWS).includes(value)
    ? /** @type {AppView} */ (value)
    : null;

/**
 * @param {unknown} value
 * @returns {value is RightPanelView}
 */
const isRightPanelView = (value) =>
  value === "browser" ||
  value === "explorer" ||
  value === "changes" ||
  value === "terminal" ||
  value === "stash" ||
  value === "pull-requests";

/**
 * @param {unknown} value
 * @returns {ChatSortOrder}
 */
const normalizeChatSort = (value) =>
  value === "createdDesc" || value === "createdAsc" || value === "titleAsc"
    ? value
    : "recent";

/**
 * @param {unknown} value
 * @returns {value is ProjectReference}
 */
const isProjectReference = (value) => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.kind === "file" || value.kind === "folder") &&
    typeof value.name === "string" &&
    typeof value.parentPath === "string" &&
    typeof value.path === "string" &&
    value.path.trim().length > 0
  );
};

/**
 * @param {unknown} value
 * @returns {StashItem | null}
 */
const normalizeStashItem = (value) => {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) {
    return null;
  }

  const createdAt =
    asNullableString(value.createdAt) ?? new Date().toISOString();

  return {
    createdAt,
    id,
    model: asString(value.model),
    modelSpeed: normalizeModelSpeed(value.modelSpeed),
    permissionMode: normalizeChatPermissionMode(
      value.permissionMode,
      value.agentMode,
    ),
    provider: normalizeProvider(value.provider),
    reasoningEffort: normalizeReasoningEffort(value.reasoningEffort),
    references: Array.isArray(value.references)
      ? value.references.filter(isProjectReference)
      : [],
    text: asString(value.text),
    updatedAt: asNullableString(value.updatedAt) ?? createdAt,
  };
};

/**
 * @param {unknown} value
 * @returns {StashItem[]}
 */
const normalizeStashItems = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set();
  /** @type {StashItem[]} */
  const items = [];
  for (const rawItem of value) {
    const item = normalizeStashItem(rawItem);
    if (!item || seenIds.has(item.id)) {
      continue;
    }

    seenIds.add(item.id);
    items.push(item);
  }

  return items;
};

/**
 * @param {unknown} value
 * @returns {BrowserTabState | null}
 */
const normalizeBrowserTab = (value) => {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) {
    return null;
  }

  return {
    canGoBack: value.canGoBack === true,
    canGoForward: value.canGoForward === true,
    id,
    title: asString(value.title).trim() || "New Tab",
    url: asString(value.url).trim(),
    zoomFactor:
      typeof value.zoomFactor === "number" && Number.isFinite(value.zoomFactor)
        ? value.zoomFactor
        : 1,
  };
};

/**
 * @param {unknown} value
 * @param {Set<string>} knownProjectIds
 * @returns {Record<string, BrowserTabState[]>}
 */
const normalizeBrowserTabsByProject = (value, knownProjectIds) => {
  if (!isRecord(value)) {
    return {};
  }

  /** @type {Record<string, BrowserTabState[]>} */
  const normalized = {};
  for (const [projectId, rawTabs] of Object.entries(value)) {
    const normalizedProjectId = projectId.trim();
    if (
      !normalizedProjectId ||
      !knownProjectIds.has(normalizedProjectId) ||
      !Array.isArray(rawTabs)
    ) {
      continue;
    }

    const seenTabIds = new Set();
    /** @type {BrowserTabState[]} */
    const tabs = [];
    for (const rawTab of rawTabs) {
      const tab = normalizeBrowserTab(rawTab);
      if (!tab || seenTabIds.has(tab.id)) {
        continue;
      }
      seenTabIds.add(tab.id);
      tabs.push(tab);
    }

    if (tabs.length > 0) {
      normalized[normalizedProjectId] = tabs;
    }
  }

  return normalized;
};

/**
 * Every project with tabs gets an active tab; a stale choice falls back to
 * the first tab.
 * @param {unknown} value
 * @param {Record<string, BrowserTabState[]>} browserTabsByProject
 * @returns {Record<string, string | null>}
 */
const normalizeActiveBrowserTabIds = (value, browserTabsByProject) => {
  const requested = asRecord(value);
  /** @type {Record<string, string | null>} */
  const normalized = {};
  for (const [projectId, tabs] of Object.entries(browserTabsByProject)) {
    const activeTabId =
      typeof requested[projectId] === "string"
        ? requested[projectId].trim()
        : "";
    normalized[projectId] = tabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : (tabs[0]?.id ?? null);
  }

  return normalized;
};

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} minimum
 * @returns {number}
 */
const normalizePanelSize = (value, fallback, minimum) =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? value
    : fallback;

/**
 * @param {unknown} value
 * @param {PanelSizes} [fallback]
 * @returns {PanelSizes}
 */
const normalizePanelSizes = (value, fallback = DEFAULT_PANEL_SIZES) => {
  const sizes = asRecord(value);
  return {
    chatHistoryPanelWidth: Math.min(
      500,
      normalizePanelSize(
        sizes.chatHistoryPanelWidth,
        fallback.chatHistoryPanelWidth,
        200,
      ),
    ),
    gitLogPanelWidth: Math.min(
      600,
      normalizePanelSize(
        sizes.gitLogPanelWidth,
        fallback.gitLogPanelWidth,
        260,
      ),
    ),
    leftSidebarWidth: normalizePanelSize(
      sizes.leftSidebarWidth,
      fallback.leftSidebarWidth,
      160,
    ),
    rightPanelWidth: normalizePanelSize(
      sizes.rightPanelWidth,
      fallback.rightPanelWidth,
      200,
    ),
    terminalHeight: normalizePanelSize(
      sizes.terminalHeight,
      fallback.terminalHeight,
      120,
    ),
  };
};

/**
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
const normalizeChatColumnWidths = (value) => {
  /** @type {Record<string, number>} */
  const widths = {};
  for (const [chatId, width] of Object.entries(asRecord(value))) {
    if (typeof width === "number" && Number.isFinite(width) && width > 0) {
      widths[chatId] = width;
    }
  }

  return widths;
};

/**
 * @param {unknown} value
 * @returns {ProjectConfig["icon"]}
 */
const normalizeProjectIcon = (value) => {
  if (!isRecord(value)) {
    return null;
  }

  const iconPath = asNullableString(value.path);
  if (!iconPath) {
    return null;
  }

  return {
    mimeType: asNullableString(value.mimeType) ?? "application/octet-stream",
    mtimeMs: typeof value.mtimeMs === "number" ? value.mtimeMs : 0,
    path: iconPath,
    source: asNullableString(value.source) ?? "unknown",
  };
};

/**
 * @param {unknown} value
 * @returns {ProjectWorktreeInfo | null}
 */
const normalizeProjectWorktree = (value) => {
  if (!isRecord(value)) {
    return null;
  }

  const repoRoot = asNullableString(value.repoRoot);
  const mainWorktreePath = asNullableString(value.mainWorktreePath);
  const branch = asNullableString(value.branch);
  if (value.kind !== "worktree" || !repoRoot || !mainWorktreePath || !branch) {
    return null;
  }

  return {
    baseRef: asNullableString(value.baseRef),
    branch,
    createdAt: asNullableString(value.createdAt) ?? new Date().toISOString(),
    kind: "worktree",
    mainWorktreePath,
    managed: value.managed === true,
    parentProjectId: asNullableString(value.parentProjectId),
    repoRoot,
  };
};

/**
 * @param {unknown} value
 * @returns {ProjectUiState}
 */
const normalizeProjectUi = (value) => {
  const ui = asRecord(value);
  // Older records stored the right panel as `panelVisibility.right`.
  const panelVisibility = asRecord(ui.panelVisibility);

  return {
    activeChatId: asNullableString(ui.activeChatId),
    openChatIds: asIdList(ui.openChatIds),
    chatColumnWidths: normalizeChatColumnWidths(ui.chatColumnWidths),
    chatHistoryPanelOpen: asBoolean(
      ui.chatHistoryPanelOpen,
      DEFAULT_PROJECT_UI.chatHistoryPanelOpen,
    ),
    changesDiffWordWrap: asBoolean(
      ui.changesDiffWordWrap,
      DEFAULT_PROJECT_UI.changesDiffWordWrap,
    ),
    fileEditorWordWrap: asBoolean(
      ui.fileEditorWordWrap,
      DEFAULT_PROJECT_UI.fileEditorWordWrap,
    ),
    multiChat: asBoolean(ui.multiChat, DEFAULT_PROJECT_UI.multiChat),
    panelSizes: normalizePanelSizes(ui.panelSizes),
    rightPanelOpen: asBoolean(
      ui.rightPanelOpen,
      asBoolean(panelVisibility.right, DEFAULT_PROJECT_UI.rightPanelOpen),
    ),
    rightPanelView: isRightPanelView(ui.rightPanelView)
      ? ui.rightPanelView
      : DEFAULT_PROJECT_UI.rightPanelView,
    stashItems: normalizeStashItems(ui.stashItems),
  };
};

/**
 * @param {unknown} value
 * @param {AppSettings} settings
 * @returns {ProjectConfig | null}
 */
const normalizeProject = (value, settings) => {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) {
    return null;
  }

  const path = asString(value.path);
  const provider = normalizeProvider(value.provider);
  const rawModel = asString(value.model);
  const model =
    provider === "anthropic"
      ? normalizeClaudeCodeModelId(rawModel)
      : rawModel.trim();

  return {
    id,
    icon: normalizeProjectIcon(value.icon),
    lastUsedAt: asTimestamp(value.lastUsedAt),
    name: asString(value.name).trim() || getProjectName(path),
    path,
    runCommand: asString(value.runCommand, "pnpm dev"),
    // `previewUrl` is the pre-browser-panel name for the same field.
    browserUrl: asString(value.browserUrl, asString(value.previewUrl)),
    provider,
    model: model || getPreferredDefaultModel(settings),
    modelSpeed: normalizeModelSpeed(value.modelSpeed),
    reasoningEffort: normalizeReasoningEffort(value.reasoningEffort),
    ui: normalizeProjectUi(value.ui),
    worktree: normalizeProjectWorktree(value.worktree),
  };
};

/**
 * @param {unknown} value
 * @param {Map<string, ProjectConfig>} projectsById
 * @param {ChatPermissionMode} legacyPermissionMode
 * @returns {ChatConfig | null}
 */
const normalizeChat = (value, projectsById, legacyPermissionMode) => {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const project =
    typeof value.projectId === "string"
      ? projectsById.get(value.projectId)
      : undefined;
  if (!id || !project) {
    return null;
  }

  const createdAt =
    asNullableString(value.createdAt) ?? new Date().toISOString();
  const provider = normalizeProvider(value.provider);
  const rawModel = asString(value.model, project.model);
  const model =
    provider === "anthropic"
      ? normalizeClaudeCodeModelId(rawModel)
      : rawModel.trim();
  const branchedFrom = asRecord(value.branchedFrom);
  const branchChatId = asNullableString(branchedFrom.chatId);
  const branchMessageId = asNullableString(branchedFrom.messageId);
  const remoteModelSpeed = asNullableString(value.remoteConversationModelSpeed);

  return {
    branchedFrom:
      branchChatId && branchMessageId
        ? { chatId: branchChatId, messageId: branchMessageId }
        : null,
    createdAt,
    deletedAt: asNullableString(value.deletedAt),
    id,
    messageCount:
      typeof value.messageCount === "number" &&
      Number.isInteger(value.messageCount) &&
      value.messageCount >= 0
        ? value.messageCount
        : 0,
    model: model || project.model,
    modelSpeed: normalizeModelSpeed(value.modelSpeed),
    // `agentMode` is the retired Plan/Build switch the old Standard mode
    // depended on.
    permissionMode: normalizeChatPermissionMode(
      value.permissionMode,
      value.agentMode,
      legacyPermissionMode,
    ),
    pinned: value.pinned === true,
    projectId: project.id,
    provider,
    reasoningEffort: normalizeReasoningEffort(value.reasoningEffort),
    remoteConversationId: asNullableString(value.remoteConversationId),
    remoteConversationModel: asNullableString(value.remoteConversationModel),
    remoteConversationModelSpeed: remoteModelSpeed
      ? normalizeModelSpeed(remoteModelSpeed)
      : null,
    remoteConversationProjectPath: asNullableString(
      value.remoteConversationProjectPath,
    ),
    sparklesPalette: normalizeSparklesPaletteName(value.sparklesPalette),
    title: asString(value.title).trim() || "New chat",
    updatedAt: asNullableString(value.updatedAt) ?? createdAt,
  };
};

/**
 * Saved prompts, dropping anything without an id or prompt text.
 * @param {unknown} value
 * @returns {SavedPrompt[]}
 */
const normalizeSavedPrompts = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set();
  /** @type {SavedPrompt[]} */
  const savedPrompts = [];
  for (const raw of value) {
    if (!isRecord(raw)) {
      continue;
    }

    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || seenIds.has(id) || typeof raw.prompt !== "string") {
      continue;
    }

    seenIds.add(id);
    const createdAt =
      asNullableString(raw.createdAt) ?? new Date().toISOString();
    savedPrompts.push({
      createdAt,
      id,
      name: asString(raw.name),
      prompt: raw.prompt,
      updatedAt: asNullableString(raw.updatedAt) ?? createdAt,
    });
  }

  return savedPrompts;
};

/**
 * Settings with every field present and valid, and the default models
 * repaired against the models actually selected. Understands the retired
 * keys `autoArchiveChatsAfterDays`, `expandShellToolParts` and
 * `expandEditToolParts`.
 * @param {unknown} value
 * @returns {AppSettings}
 */
const normalizeSettings = (value) => {
  const raw = asRecord(value);
  const archiveDays = [
    raw.archiveChatsAfterDays,
    raw.autoArchiveChatsAfterDays,
  ].find(
    (days) => typeof days === "number" && Number.isInteger(days) && days > 0,
  );

  /** @type {AppSettings} */
  const settings = {
    archiveChatsAfterDays:
      typeof archiveDays === "number"
        ? archiveDays
        : DEFAULT_SETTINGS.archiveChatsAfterDays,
    autoCompactContext: asBoolean(
      raw.autoCompactContext,
      DEFAULT_SETTINGS.autoCompactContext,
    ),
    anthropicSelectedModels: dedupeModels(
      asStringArray(raw.anthropicSelectedModels).map(
        normalizeClaudeCodeModelId,
      ),
    ),
    defaultModel: asString(raw.defaultModel),
    defaultGitGenerationModel: asString(raw.defaultGitGenerationModel),
    defaultGitGenerationModelSpeed: normalizeModelSpeed(
      raw.defaultGitGenerationModelSpeed,
    ),
    // A stored `null` is the explicit "medium" choice; a missing key is a
    // profile from before the setting existed, which keeps the original low.
    defaultGitGenerationReasoningEffort:
      raw.defaultGitGenerationReasoningEffort === undefined
        ? DEFAULT_SETTINGS.defaultGitGenerationReasoningEffort
        : normalizeReasoningEffort(raw.defaultGitGenerationReasoningEffort),
    defaultModelSpeed: normalizeModelSpeed(raw.defaultModelSpeed),
    defaultPermissionMode: normalizeChatPermissionMode(
      raw.defaultPermissionMode,
      undefined,
      DEFAULT_SETTINGS.defaultPermissionMode,
    ),
    defaultReasoningEffort: normalizeReasoningEffort(
      raw.defaultReasoningEffort,
    ),
    disabledProviders: Array.isArray(raw.disabledProviders)
      ? ALL_PROVIDERS.filter((provider) =>
          /** @type {unknown[]} */ (raw.disabledProviders).includes(provider),
        )
      : [],
    changeCheckpoints: asBoolean(
      raw.changeCheckpoints,
      DEFAULT_SETTINGS.changeCheckpoints,
    ),
    expandToolCalls:
      typeof raw.expandToolCalls === "boolean"
        ? raw.expandToolCalls
        : typeof raw.expandShellToolParts === "boolean" ||
            typeof raw.expandEditToolParts === "boolean"
          ? raw.expandShellToolParts === true ||
            raw.expandEditToolParts === true
          : DEFAULT_SETTINGS.expandToolCalls,
    groupToolCalls: asBoolean(
      raw.groupToolCalls,
      DEFAULT_SETTINGS.groupToolCalls,
    ),
    cursorSelectedModels: dedupeModels(asStringArray(raw.cursorSelectedModels)),
    grokSelectedModels: dedupeModels(asStringArray(raw.grokSelectedModels)),
    locale: normalizeLocalePreference(raw.locale),
    mcpServers: normalizeMcpServerList(raw.mcpServers),
    openAiSelectedModels: dedupeModels(asStringArray(raw.openAiSelectedModels)),
    openCodeSelectedModels: dedupeModels(
      asStringArray(raw.openCodeSelectedModels),
    ),
    showReasoningSummaries: asBoolean(
      raw.showReasoningSummaries,
      DEFAULT_SETTINGS.showReasoningSummaries,
    ),
    shellPath: asString(raw.shellPath),
  };

  return normalizeDefaultModelSettings(settings);
};

// ── Invariants shared with the store ──────────────────────────────────

/**
 * @param {ProjectConfig[]} projects
 * @param {string | null} activeProjectId
 * @returns {string | null}
 */
export const ensureActiveProject = (projects, activeProjectId) => {
  if (
    activeProjectId &&
    projects.some((project) => project.id === activeProjectId)
  ) {
    return activeProjectId;
  }

  return projects[0]?.id ?? null;
};

/**
 * @param {ChatConfig[]} chats
 * @param {string} projectId
 * @param {string | null} activeChatId
 * @returns {string | null}
 */
export const ensureActiveChatForProject = (chats, projectId, activeChatId) => {
  const projectChats = chats.filter(
    (chat) => chat.projectId === projectId && chat.deletedAt === null,
  );
  if (activeChatId && projectChats.some((chat) => chat.id === activeChatId)) {
    return activeChatId;
  }

  return projectChats[0]?.id ?? null;
};

/**
 * A project's UI must only name chats that exist and are not deleted: the
 * active chat falls back to the first live chat, open chats are trimmed to
 * live ones (and to the active chat alone outside multi-chat), and column
 * widths follow the open chats.
 * @param {ChatConfig[]} chats
 * @param {string} projectId
 * @param {ProjectUiState} ui
 * @param {string | null} [preferredActiveChatId]
 * @returns {ProjectUiState}
 */
export const sanitizeProjectUiForChats = (
  chats,
  projectId,
  ui,
  preferredActiveChatId = ui.activeChatId,
) => {
  const projectChats = chats.filter(
    (chat) => chat.projectId === projectId && chat.deletedAt === null,
  );
  const availableChatIds = new Set(projectChats.map((chat) => chat.id));
  const activeChatId =
    preferredActiveChatId && availableChatIds.has(preferredActiveChatId)
      ? preferredActiveChatId
      : (projectChats[0]?.id ?? null);
  const openChatIds = ui.openChatIds.filter((chatId) =>
    availableChatIds.has(chatId),
  );

  const nextOpenChatIds = ui.multiChat ? openChatIds : [];
  if (activeChatId) {
    if (ui.multiChat) {
      if (!nextOpenChatIds.includes(activeChatId)) {
        nextOpenChatIds.push(activeChatId);
      }
    } else {
      nextOpenChatIds.splice(0, nextOpenChatIds.length, activeChatId);
    }
  }

  const openChatIdSet = new Set(nextOpenChatIds);
  const chatColumnWidths = Object.fromEntries(
    Object.entries(ui.chatColumnWidths).filter(
      ([chatId, width]) =>
        openChatIdSet.has(chatId) && Number.isFinite(width) && width > 0,
    ),
  );

  return {
    ...ui,
    activeChatId,
    multiChat: ui.multiChat === true,
    openChatIds: nextOpenChatIds,
    chatColumnWidths,
  };
};

/**
 * @param {ProjectConfig} project
 * @param {Partial<Pick<ChatConfig, "model" | "modelSpeed" | "permissionMode" | "provider" | "reasoningEffort" | "title">>} [overrides]
 * @returns {ChatConfig}
 */
export const createChatConfig = (project, overrides) => {
  const timestamp = new Date().toISOString();

  return {
    branchedFrom: null,
    createdAt: timestamp,
    deletedAt: null,
    id: crypto.randomUUID(),
    messageCount: 0,
    model: overrides?.model ?? project.model,
    modelSpeed: overrides?.modelSpeed ?? project.modelSpeed,
    permissionMode: overrides?.permissionMode ?? "full-access",
    pinned: false,
    projectId: project.id,
    provider: overrides?.provider ?? project.provider,
    reasoningEffort:
      overrides && "reasoningEffort" in overrides
        ? (overrides.reasoningEffort ?? null)
        : project.reasoningEffort,
    remoteConversationId: null,
    remoteConversationModel: null,
    remoteConversationModelSpeed: null,
    remoteConversationProjectPath: null,
    sparklesPalette: DEFAULT_SPARKLES_PALETTE,
    title: overrides?.title?.trim() || "New chat",
    updatedAt: timestamp,
  };
};

/**
 * The chat a project gets when it has none: the workspace default model,
 * speed, provider and reasoning effort (the project's own when no default
 * model is set) and the default permission mode. Both processes create
 * default chats through this, so every "new chat" looks the same.
 * @param {ProjectConfig} project
 * @param {AppSettings} settings
 * @param {Partial<Pick<ChatConfig, "title">>} [overrides]
 * @returns {ChatConfig}
 */
export const createDefaultChatConfig = (project, settings, overrides) => {
  const selection = getDefaultModelSelection(settings);
  return createChatConfig(project, {
    model: selection.model || project.model,
    modelSpeed: selection.model ? selection.modelSpeed : project.modelSpeed,
    permissionMode: settings.defaultPermissionMode,
    provider: selection.model ? selection.provider : project.provider,
    reasoningEffort: selection.model
      ? selection.reasoningEffort
      : project.reasoningEffort,
    title: overrides?.title,
  });
};

// ── Decode ────────────────────────────────────────────────────────────

/**
 * Open projects deduplicated by id and by directory; closed projects also
 * yield to any open project with the same id or directory.
 * @param {unknown} rawOpen
 * @param {unknown} rawClosed
 * @param {AppSettings} settings
 * @returns {{ projects: ProjectConfig[], closedProjects: ProjectConfig[] }}
 */
const decodeProjects = (rawOpen, rawClosed, settings) => {
  const seenIds = new Set();
  const seenPathKeys = new Set();
  /** @type {ProjectConfig[]} */
  const projects = [];
  /** @type {ProjectConfig[]} */
  const closedProjects = [];

  for (const [list, target] of [
    [rawOpen, projects],
    [rawClosed, closedProjects],
  ]) {
    for (const raw of Array.isArray(list) ? list : []) {
      const project = normalizeProject(raw, settings);
      if (!project) {
        continue;
      }

      const pathKey = normalizeProjectPathKey(project.path);
      if (seenIds.has(project.id) || seenPathKeys.has(pathKey)) {
        continue;
      }

      seenIds.add(project.id);
      seenPathKeys.add(pathKey);
      /** @type {ProjectConfig[]} */ (target).push(project);
    }
  }

  return { projects, closedProjects };
};

/**
 * Repairs anything shaped like persisted state into a valid
 * `PersistedIdeState`: defaults for every missing field, retired field names
 * understood, invalid entries dropped, and the project/chat invariants
 * enforced (every open project has a live chat, the active chat exists,
 * open chats exist). Runs once, on load, in the main process.
 * @param {unknown} raw
 * @returns {PersistedIdeState}
 */
export const decodePersistedState = (raw) => {
  if (!isRecord(raw)) {
    return createEmptyPersistedState();
  }

  const rawSettings = asRecord(raw.settings);
  const settings = normalizeSettings(rawSettings);
  // Chats saved before permission modes existed inherit the retired
  // auto-accept switch; an unknown value is never a grant.
  /** @type {ChatPermissionMode} */
  const legacyPermissionMode =
    rawSettings.autoAcceptPermissions === true ? "full-access" : "ask";

  const { projects, closedProjects } = decodeProjects(
    raw.projects,
    raw.closedProjects,
    settings,
  );
  const allProjects = [...projects, ...closedProjects];
  const projectsById = new Map(
    allProjects.map((project) => [project.id, project]),
  );

  /** @type {ChatConfig[]} */
  const chats = [];
  const seenChatIds = new Set();
  for (const rawChat of Array.isArray(raw.chats) ? raw.chats : []) {
    const chat = normalizeChat(rawChat, projectsById, legacyPermissionMode);
    if (!chat || seenChatIds.has(chat.id)) {
      continue;
    }
    seenChatIds.add(chat.id);
    chats.push(chat);
  }

  // Every open project has at least one chat to show.
  const projectIdsWithChats = new Set(chats.map((chat) => chat.projectId));
  for (const project of projects) {
    if (!projectIdsWithChats.has(project.id)) {
      chats.push(createDefaultChatConfig(project, settings));
      projectIdsWithChats.add(project.id);
    }
  }

  // Transcripts arrive only with a legacy blob; relational loads omit them
  // and a chat loads its messages when its panel first opens. A chat known
  // to have no messages gets an empty loaded entry so nothing is fetched.
  const rawMessages = asRecord(raw.messagesByChatId);
  /** @type {Record<string, UIMessage[]>} */
  const messagesByChatId = {};
  for (const chat of chats) {
    const messages = rawMessages[chat.id];
    if (Array.isArray(messages)) {
      messagesByChatId[chat.id] = /** @type {UIMessage[]} */ (messages);
      chat.messageCount = messages.length;
    } else if (chat.messageCount === 0) {
      messagesByChatId[chat.id] = [];
    }
  }

  /** @param {ProjectConfig} project */
  const applyInvariants = (project) => ({
    ...project,
    ui: sanitizeProjectUiForChats(chats, project.id, project.ui),
  });
  const projectsWithUi = projects.map(applyInvariants);
  const closedProjectsWithUi = closedProjects.map(applyInvariants);

  const knownProjectIds = new Set(allProjects.map((project) => project.id));
  const browserTabsByProject = normalizeBrowserTabsByProject(
    raw.browserTabsByProject,
    knownProjectIds,
  );

  return {
    activeProjectId: ensureActiveProject(
      projectsWithUi,
      asNullableString(raw.activeProjectId),
    ),
    appView: normalizeAppView(raw.appView) ?? DEFAULT_APP_VIEW,
    savedPrompts: normalizeSavedPrompts(raw.savedPrompts),
    activeBrowserTabIdByProject: normalizeActiveBrowserTabIds(
      raw.activeBrowserTabIdByProject,
      browserTabsByProject,
    ),
    browserTabsByProject,
    chats,
    chatSort: normalizeChatSort(raw.chatSort),
    closedProjects: closedProjectsWithUi,
    messagesByChatId,
    projects: projectsWithUi,
    settings,
  };
};

// ── Encode ────────────────────────────────────────────────────────────

/**
 * Trims live state down to what deserves to be saved. Chats survive when
 * they have messages, are pinned, are soft-deleted, or are the chat currently
 * open for their project (so a fresh chat survives a restart); other empty
 * drafts are dropped. Chats and browser tabs of unknown projects are dropped.
 * A transcript key is kept only when the renderer has it loaded, so a
 * metadata-only save never erases lazily loaded rows.
 * @param {PersistedIdeState} state
 * @returns {PersistedIdeState}
 */
export const encodePersistedState = (state) => {
  const settings = normalizeSettings(state.settings);
  const { projects, closedProjects } = decodeProjects(
    state.projects,
    state.closedProjects,
    settings,
  );
  const allProjects = [...projects, ...closedProjects];
  const knownProjectIds = new Set(allProjects.map((project) => project.id));
  const activeChatIdByProject = new Map(
    allProjects.map((project) => [project.id, project.ui.activeChatId]),
  );
  const messagesByChatId = asRecord(state.messagesByChatId);

  const chats = (Array.isArray(state.chats) ? state.chats : []).filter(
    (chat) => {
      if (!isRecord(chat) || typeof chat.id !== "string" || !chat.id.trim()) {
        return false;
      }
      if (!knownProjectIds.has(chat.projectId)) {
        return false;
      }
      if (chat.deletedAt !== null) {
        return true;
      }

      const loadedMessages = messagesByChatId[chat.id];
      const messageCount = Array.isArray(loadedMessages)
        ? loadedMessages.length
        : (chat.messageCount ?? 0);
      if (messageCount > 0 || chat.pinned) {
        return true;
      }

      return activeChatIdByProject.get(chat.projectId) === chat.id;
    },
  );

  /** @type {Record<string, UIMessage[]>} */
  const persistedMessagesByChatId = {};
  for (const chat of chats) {
    if (Object.hasOwn(messagesByChatId, chat.id)) {
      persistedMessagesByChatId[chat.id] = /** @type {UIMessage[]} */ (
        messagesByChatId[chat.id]
      );
    }
  }

  /** @param {ProjectConfig} project */
  const sanitizeProject = (project) => ({
    ...project,
    ui: sanitizeProjectUiForChats(chats, project.id, project.ui),
  });
  const persistedProjects = projects.map(sanitizeProject);
  const persistedClosedProjects = closedProjects.map(sanitizeProject);

  const browserTabsByProject = normalizeBrowserTabsByProject(
    state.browserTabsByProject,
    knownProjectIds,
  );

  return {
    activeProjectId: ensureActiveProject(
      persistedProjects,
      state.activeProjectId,
    ),
    appView: normalizeAppView(state.appView) ?? DEFAULT_APP_VIEW,
    savedPrompts: normalizeSavedPrompts(state.savedPrompts),
    activeBrowserTabIdByProject: normalizeActiveBrowserTabIds(
      state.activeBrowserTabIdByProject,
      browserTabsByProject,
    ),
    browserTabsByProject,
    chats,
    chatSort: normalizeChatSort(state.chatSort),
    closedProjects: persistedClosedProjects,
    messagesByChatId: persistedMessagesByChatId,
    projects: persistedProjects,
    settings,
  };
};

// ── Rows ──────────────────────────────────────────────────────────────
//
// Projects and chats are stored as a few columns plus a JSON `metadata`
// blob. The row mappers are deliberately dumb: they move fields between the
// two shapes and tolerate junk, and leave repair to decodePersistedState.

/**
 * @typedef {object} ProjectRow
 * @property {string} id
 * @property {string} path
 * @property {string} normalizedPath
 * @property {string} name
 * @property {"open" | "closed"} status
 * @property {number} sortOrder
 * @property {UnknownRecord} metadata
 */

/**
 * @param {ProjectConfig} project
 * @param {"open" | "closed"} status
 * @param {number} sortOrder
 * @returns {ProjectRow}
 */
export const projectToRow = (project, status, sortOrder) => {
  const path = asString(project.path);
  const ui = asRecord(project.ui);

  return {
    id: project.id,
    path,
    normalizedPath: normalizeProjectPathKey(path),
    name: asString(project.name).trim() || getProjectName(path),
    status,
    sortOrder,
    metadata: {
      browser: { url: asString(project.browserUrl) },
      icon: isRecord(project.icon) ? project.icon : null,
      lastUsedAt: asTimestamp(project.lastUsedAt),
      modelSelection: {
        model: asString(project.model),
        modelSpeed: asString(project.modelSpeed, "standard"),
        provider: asString(project.provider, "openai"),
        reasoningEffort: asNullableString(project.reasoningEffort),
      },
      runCommand: asString(project.runCommand, "pnpm dev"),
      ui: {
        activeChatId: asNullableString(ui.activeChatId),
        openChatIds: asIdList(ui.openChatIds),
        chatColumnWidths: normalizeChatColumnWidths(ui.chatColumnWidths),
        chatHistoryPanelOpen: ui.chatHistoryPanelOpen === true,
        changesDiffWordWrap: ui.changesDiffWordWrap === true,
        fileEditorWordWrap: ui.fileEditorWordWrap === true,
        multiChat: ui.multiChat === true,
        panelSizes: normalizePanelSizes(ui.panelSizes),
        rightPanelOpen: asBoolean(
          ui.rightPanelOpen,
          asBoolean(
            asRecord(ui.panelVisibility).right,
            DEFAULT_PROJECT_UI.rightPanelOpen,
          ),
        ),
        rightPanelView: isRightPanelView(ui.rightPanelView)
          ? ui.rightPanelView
          : DEFAULT_PROJECT_UI.rightPanelView,
        stashItems: Array.isArray(ui.stashItems) ? ui.stashItems : [],
      },
      worktree: isRecord(project.worktree) ? project.worktree : null,
    },
  };
};

/**
 * The raw project a row describes, for decodePersistedState.
 * @param {{ id: unknown, path: unknown, name: unknown, metadata: unknown }} row
 * @returns {UnknownRecord}
 */
export const projectFromRow = (row) => {
  const metadata = asRecord(row.metadata);
  const modelSelection = asRecord(metadata.modelSelection);

  return {
    browserUrl: asRecord(metadata.browser).url,
    icon: metadata.icon,
    id: row.id,
    lastUsedAt: metadata.lastUsedAt,
    model: modelSelection.model,
    modelSpeed: modelSelection.modelSpeed,
    name: row.name,
    path: row.path,
    provider: modelSelection.provider,
    reasoningEffort: modelSelection.reasoningEffort,
    runCommand: metadata.runCommand,
    ui: metadata.ui,
    worktree: metadata.worktree,
  };
};

/**
 * @typedef {object} ChatRow
 * @property {string} id
 * @property {string} projectId
 * @property {string} title
 * @property {UnknownRecord} metadata
 * @property {string | null} createdAt
 * @property {string | null} updatedAt
 * @property {string | null} deletedAt
 */

/**
 * @param {ChatConfig} chat
 * @returns {ChatRow}
 */
export const chatToRow = (chat) => {
  const branchedFrom = asRecord(chat.branchedFrom);
  const branchChatId = asNullableString(branchedFrom.chatId);
  const branchMessageId = asNullableString(branchedFrom.messageId);

  return {
    id: chat.id,
    projectId: chat.projectId,
    title: asString(chat.title).trim() || "New chat",
    createdAt: asNullableString(chat.createdAt),
    updatedAt: asNullableString(chat.updatedAt),
    deletedAt: asNullableString(chat.deletedAt),
    metadata: {
      branchedFrom:
        branchChatId && branchMessageId
          ? { chatId: branchChatId, messageId: branchMessageId }
          : null,
      messageCount:
        Number.isInteger(chat.messageCount) && chat.messageCount >= 0
          ? chat.messageCount
          : 0,
      modelSelection: {
        model: asString(chat.model),
        modelSpeed: asString(chat.modelSpeed, "standard"),
        provider: asString(chat.provider, "openai"),
        reasoningEffort: asNullableString(chat.reasoningEffort),
      },
      permissions: {
        mode: normalizeChatPermissionMode(
          chat.permissionMode,
          /** @type {UnknownRecord} */ (/** @type {unknown} */ (chat))
            .agentMode,
        ),
      },
      pinned: chat.pinned === true,
      remoteConversation: {
        id: asNullableString(chat.remoteConversationId),
        model: asNullableString(chat.remoteConversationModel),
        modelSpeed: asNullableString(chat.remoteConversationModelSpeed),
        projectPath: asNullableString(chat.remoteConversationProjectPath),
      },
      sparklesPalette: normalizeSparklesPaletteName(chat.sparklesPalette),
    },
  };
};

/**
 * The raw chat a row describes, for decodePersistedState. `messageCount` is
 * the live count from the messages table when the caller supplies it.
 * @param {{ id: unknown, project_id: unknown, title: unknown, metadata: unknown, created_at: unknown, updated_at: unknown, deleted_at: unknown, message_count?: unknown }} row
 * @returns {UnknownRecord}
 */
export const chatFromRow = (row) => {
  const metadata = asRecord(row.metadata);
  const modelSelection = asRecord(metadata.modelSelection);
  const remoteConversation = asRecord(metadata.remoteConversation);

  return {
    // The retired Plan/Build switch, kept so an old Standard mode reads right.
    agentMode: modelSelection.agentMode,
    branchedFrom: metadata.branchedFrom,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    id: row.id,
    messageCount:
      typeof row.message_count === "number"
        ? row.message_count
        : metadata.messageCount,
    model: modelSelection.model,
    modelSpeed: modelSelection.modelSpeed,
    permissionMode: asRecord(metadata.permissions).mode,
    pinned: metadata.pinned,
    projectId: row.project_id,
    provider: modelSelection.provider,
    reasoningEffort: modelSelection.reasoningEffort,
    remoteConversationId: remoteConversation.id,
    remoteConversationModel: remoteConversation.model,
    remoteConversationModelSpeed: remoteConversation.modelSpeed,
    remoteConversationProjectPath: remoteConversation.projectPath,
    sparklesPalette: metadata.sparklesPalette,
    title: row.title,
    updatedAt: row.updated_at,
  };
};

const SETTINGS_CONFIG_PREFIX = "settings.";

/**
 * The top-level fields and settings as `config` rows: one key per value,
 * settings under `settings.<name>`.
 * @param {PersistedIdeState} state
 * @returns {Record<string, unknown>}
 */
export const stateToConfig = (state) => {
  /** @type {Record<string, unknown>} */
  const config = {
    activeProjectId: asNullableString(state.activeProjectId),
    appView: normalizeAppView(state.appView) ?? DEFAULT_APP_VIEW,
    chatSort: normalizeChatSort(state.chatSort),
    browserTabsByProject: asRecord(state.browserTabsByProject),
    activeBrowserTabIdByProject: asRecord(state.activeBrowserTabIdByProject),
  };
  for (const [key, value] of Object.entries(asRecord(state.settings))) {
    config[`${SETTINGS_CONFIG_PREFIX}${key}`] = value;
  }

  return config;
};

/**
 * The raw top-level fields and settings the `config` rows describe, for
 * decodePersistedState. A key that is absent stays absent, which is how a
 * profile from before a setting existed is told apart from a stored `null`.
 * @param {Record<string, unknown>} config
 * @returns {UnknownRecord}
 */
export const stateFromConfig = (config) => {
  /** @type {UnknownRecord} */
  const settings = {};
  for (const [key, value] of Object.entries(config)) {
    if (key.startsWith(SETTINGS_CONFIG_PREFIX)) {
      settings[key.slice(SETTINGS_CONFIG_PREFIX.length)] = value;
    }
  }

  return {
    activeProjectId: config.activeProjectId,
    appView: config.appView,
    chatSort: config.chatSort,
    browserTabsByProject: config.browserTabsByProject,
    activeBrowserTabIdByProject: config.activeBrowserTabIdByProject,
    settings,
  };
};
