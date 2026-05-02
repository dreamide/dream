import type {
  DynamicToolUIPart,
  FileUIPart,
  ReasoningUIPart,
  SourceDocumentUIPart,
  SourceUrlUIPart,
  TextUIPart,
  ToolUIPart,
  UIMessage,
} from "ai";
import {
  createChatConfig,
  DEFAULT_PANEL_SIZES,
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_PROJECT_UI,
  DEFAULT_PROVIDER,
  DEFAULT_SETTINGS,
  getPreferredDefaultModel,
  normalizeClaudeCodeModelId,
} from "@/lib/ide-defaults";
import type {
  AppSettings,
  BrowserTabState,
  ChatConfig,
  PersistedIdeState,
  ProjectConfig,
  RightPanelView,
} from "@/types/ide";
import { dedupeModels, normalizeReasoningEffort } from "./ide-types";

export const emptyState: PersistedIdeState = {
  activeProjectId: null,
  activeBrowserTabIdByProject: {},
  browserTabsByProject: {},
  chats: [],
  closedProjects: [],
  messagesByChatId: {},
  projects: [],
  settings: DEFAULT_SETTINGS,
  chatSort: "recent",
};

type LegacyPersistedIdeState = Partial<PersistedIdeState> & {
  activeChatIdByProject?: Record<string, string | null>;
  activeThreadIdByProject?: Record<string, string | null>;
  panelSizes?: unknown;
  panelVisibility?: Partial<{ left: boolean; middle: boolean; right: boolean }>;
  projectPanelSizesByProject?: Record<string, unknown>;
  projectRightPanelOpenByProject?: Record<string, unknown>;
  projectRightPanelViewByProject?: Record<string, unknown>;
};

export const normalizeProjectPathKey = (path: string): string => {
  const trimmed = path.trim();
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, "") || trimmed;
  const normalized = withoutTrailingSeparators.replace(/\\/g, "/");
  const isWindowsPath = /^[a-zA-Z]:\//.test(normalized) || path.includes("\\");

  return isWindowsPath ? normalized.toLowerCase() : normalized;
};

const isUiMessageArray = (value: unknown): value is UIMessage[] => {
  return Array.isArray(value);
};

const isRightPanelView = (value: unknown): value is RightPanelView =>
  value === "browser" || value === "explorer" || value === "changes";

const normalizeBrowserTab = (value: unknown): BrowserTabState | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const tab = value as Partial<BrowserTabState>;
  const id = typeof tab.id === "string" ? tab.id.trim() : "";
  if (!id) {
    return null;
  }

  const url = typeof tab.url === "string" ? tab.url.trim() : "";
  const title = typeof tab.title === "string" ? tab.title.trim() : "";
  return {
    canGoBack: tab.canGoBack === true,
    canGoForward: tab.canGoForward === true,
    id,
    title: title || "New Tab",
    url,
  };
};

const normalizeBrowserTabsByProject = (
  value: unknown,
): Record<string, BrowserTabState[]> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized: Record<string, BrowserTabState[]> = {};
  for (const [projectId, rawTabs] of Object.entries(value)) {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId || !Array.isArray(rawTabs)) {
      continue;
    }

    const seenTabIds = new Set<string>();
    const tabs = rawTabs
      .map(normalizeBrowserTab)
      .filter((tab): tab is BrowserTabState => {
        if (!tab || seenTabIds.has(tab.id)) {
          return false;
        }
        seenTabIds.add(tab.id);
        return true;
      });

    if (tabs.length > 0) {
      normalized[normalizedProjectId] = tabs;
    }
  }

  return normalized;
};

const normalizeActiveBrowserTabIds = (
  value: unknown,
  browserTabsByProject: Record<string, BrowserTabState[]>,
): Record<string, string | null> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(browserTabsByProject).map(([projectId, tabs]) => [
        projectId,
        tabs[0]?.id ?? null,
      ]),
    );
  }

  const normalized: Record<string, string | null> = {};
  for (const [projectId, tabs] of Object.entries(browserTabsByProject)) {
    const rawActiveTabId = (value as Record<string, unknown>)[projectId];
    const activeTabId =
      typeof rawActiveTabId === "string" ? rawActiveTabId.trim() : "";
    normalized[projectId] = tabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : (tabs[0]?.id ?? null);
  }

  return normalized;
};

const normalizePanelSize = (
  value: unknown,
  fallback: number,
  minimum: number,
): number =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum
    ? value
    : fallback;

const normalizePanelSizes = (
  value: unknown,
  fallback = DEFAULT_PANEL_SIZES,
) => {
  const panelSizes = value && typeof value === "object" ? value : {};
  return {
    chatHistoryPanelWidth: Math.min(
      500,
      normalizePanelSize(
        (panelSizes as Partial<typeof DEFAULT_PANEL_SIZES>)
          .chatHistoryPanelWidth,
        fallback.chatHistoryPanelWidth,
        200,
      ),
    ),
    leftSidebarWidth: normalizePanelSize(
      (panelSizes as Partial<typeof DEFAULT_PANEL_SIZES>).leftSidebarWidth,
      fallback.leftSidebarWidth,
      160,
    ),
    rightPanelWidth: normalizePanelSize(
      (panelSizes as Partial<typeof DEFAULT_PANEL_SIZES>).rightPanelWidth,
      fallback.rightPanelWidth,
      200,
    ),
    terminalHeight: normalizePanelSize(
      (panelSizes as Partial<typeof DEFAULT_PANEL_SIZES>).terminalHeight,
      fallback.terminalHeight,
      120,
    ),
  };
};

const normalizeProvider = (value: unknown): "openai" | "anthropic" => {
  return value === "anthropic" ? value : DEFAULT_PROVIDER;
};

const normalizeProjectIcon = (value: unknown): ProjectConfig["icon"] => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const icon = value as Partial<NonNullable<ProjectConfig["icon"]>>;
  const iconPath = typeof icon.path === "string" ? icon.path.trim() : "";
  if (!iconPath) {
    return null;
  }

  return {
    mimeType:
      typeof icon.mimeType === "string" && icon.mimeType.trim()
        ? icon.mimeType.trim()
        : "application/octet-stream",
    mtimeMs: typeof icon.mtimeMs === "number" ? icon.mtimeMs : 0,
    path: iconPath,
    source:
      typeof icon.source === "string" && icon.source.trim()
        ? icon.source.trim()
        : "unknown",
  };
};

const normalizeProject = (
  project: ProjectConfig,
  settings: AppSettings,
): ProjectConfig => {
  const rawProject = project as ProjectConfig & {
    metadata?: unknown;
    previewUrl?: unknown;
    ui?: unknown;
  };
  const rawMetadata =
    rawProject.metadata && typeof rawProject.metadata === "object"
      ? (rawProject.metadata as { icon?: unknown; ui?: unknown })
      : {};
  const rawUi =
    rawProject.ui && typeof rawProject.ui === "object"
      ? (rawProject.ui as unknown as Record<string, unknown>)
      : rawMetadata.ui && typeof rawMetadata.ui === "object"
        ? (rawMetadata.ui as Record<string, unknown>)
        : {};
  const rawPanelVisibility =
    rawUi.panelVisibility && typeof rawUi.panelVisibility === "object"
      ? (rawUi.panelVisibility as Record<string, unknown>)
      : {};
  const browserUrl =
    typeof rawProject.browserUrl === "string"
      ? rawProject.browserUrl
      : typeof rawProject.previewUrl === "string"
        ? rawProject.previewUrl
        : "http://127.0.0.1:3000";
  const provider = normalizeProvider(project.provider);
  const model =
    typeof project.model === "string"
      ? provider === "anthropic"
        ? normalizeClaudeCodeModelId(project.model)
        : project.model.trim()
      : "";
  const defaultModel = getPreferredDefaultModel(settings);

  return {
    ...project,
    browserUrl,
    icon: normalizeProjectIcon(rawProject.icon ?? rawMetadata.icon),
    model: model || defaultModel,
    provider,
    reasoningEffort: normalizeReasoningEffort(project.reasoningEffort),
    ui: {
      activeChatId:
        typeof rawUi.activeChatId === "string" && rawUi.activeChatId.trim()
          ? rawUi.activeChatId
          : null,
      chatHistoryPanelOpen:
        typeof rawUi.chatHistoryPanelOpen === "boolean"
          ? rawUi.chatHistoryPanelOpen
          : DEFAULT_PROJECT_UI.chatHistoryPanelOpen,
      panelSizes: normalizePanelSizes(rawUi.panelSizes),
      rightPanelOpen:
        typeof rawUi.rightPanelOpen === "boolean"
          ? rawUi.rightPanelOpen
          : typeof rawPanelVisibility.right === "boolean"
            ? rawPanelVisibility.right
            : DEFAULT_PROJECT_UI.rightPanelOpen,
      rightPanelView: isRightPanelView(rawUi.rightPanelView)
        ? rawUi.rightPanelView
        : DEFAULT_PROJECT_UI.rightPanelView,
    },
  };
};

const normalizeChat = (
  chat: ChatConfig,
  projectsById: Map<string, ProjectConfig>,
): ChatConfig | null => {
  const project = projectsById.get(chat.projectId);
  if (!project) {
    return null;
  }

  const title = typeof chat.title === "string" ? chat.title.trim() : "";
  const createdAt =
    typeof chat.createdAt === "string" && chat.createdAt.trim().length > 0
      ? chat.createdAt
      : new Date().toISOString();
  const updatedAt =
    typeof chat.updatedAt === "string" && chat.updatedAt.trim().length > 0
      ? chat.updatedAt
      : createdAt;
  const provider = normalizeProvider(chat.provider);
  const model =
    typeof chat.model === "string"
      ? provider === "anthropic"
        ? normalizeClaudeCodeModelId(chat.model)
        : chat.model.trim()
      : project.model;
  const rawChat = chat as ChatConfig & {
    deletedAt?: unknown;
    metadata?: unknown;
  };
  const deletedAt =
    typeof rawChat.deletedAt === "string" && rawChat.deletedAt.trim().length > 0
      ? rawChat.deletedAt
      : null;

  return {
    createdAt,
    deletedAt,
    ...(rawChat.metadata && typeof rawChat.metadata === "object"
      ? { metadata: rawChat.metadata }
      : {}),
    id: chat.id,
    model: model || project.model,
    projectId: chat.projectId,
    provider,
    reasoningEffort: normalizeReasoningEffort(chat.reasoningEffort),
    remoteConversationId:
      typeof chat.remoteConversationId === "string" &&
      chat.remoteConversationId.trim().length > 0
        ? chat.remoteConversationId
        : null,
    remoteConversationModel:
      typeof chat.remoteConversationModel === "string" &&
      chat.remoteConversationModel.trim().length > 0
        ? chat.remoteConversationModel
        : null,
    remoteConversationProjectPath:
      typeof chat.remoteConversationProjectPath === "string" &&
      chat.remoteConversationProjectPath.trim().length > 0
        ? chat.remoteConversationProjectPath
        : null,
    title: title || "New chat",
    updatedAt,
  } as ChatConfig;
};

export const mergePersistedState = (
  state: Partial<PersistedIdeState> | null | undefined,
): PersistedIdeState => {
  if (!state) {
    return emptyState;
  }

  const legacyState = state as LegacyPersistedIdeState;

  const rawSettings = (state.settings ?? {}) as Partial<AppSettings> &
    Record<string, unknown>;

  const mergedSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    anthropicSelectedModels: dedupeModels(
      Array.isArray(rawSettings.anthropicSelectedModels)
        ? rawSettings.anthropicSelectedModels.map(normalizeClaudeCodeModelId)
        : [],
    ),
    autoAcceptPermissions:
      typeof rawSettings.autoAcceptPermissions === "boolean"
        ? rawSettings.autoAcceptPermissions
        : DEFAULT_SETTINGS.autoAcceptPermissions,
    defaultModel:
      typeof rawSettings.defaultModel === "string"
        ? rawSettings.defaultModel
        : "",
    expandToolCalls:
      typeof rawSettings.expandToolCalls === "boolean"
        ? rawSettings.expandToolCalls
        : typeof rawSettings.expandShellToolParts === "boolean" ||
            typeof rawSettings.expandEditToolParts === "boolean"
          ? rawSettings.expandShellToolParts === true ||
            rawSettings.expandEditToolParts === true
          : DEFAULT_SETTINGS.expandToolCalls,
    openAiSelectedModels: dedupeModels(
      Array.isArray(rawSettings.openAiSelectedModels)
        ? rawSettings.openAiSelectedModels
        : [],
    ),
    showReasoningSummaries:
      typeof rawSettings.showReasoningSummaries === "boolean"
        ? rawSettings.showReasoningSummaries
        : DEFAULT_SETTINGS.showReasoningSummaries,
    shellPath:
      typeof rawSettings.shellPath === "string" ? rawSettings.shellPath : "",
  };

  const legacyDefaultCandidates = [
    mergedSettings.defaultModel,
    typeof rawSettings.defaultOpenAiModel === "string"
      ? rawSettings.defaultOpenAiModel
      : "",
    typeof rawSettings.defaultAnthropicModel === "string"
      ? normalizeClaudeCodeModelId(rawSettings.defaultAnthropicModel)
      : "",
  ].filter(
    (model): model is string => typeof model === "string" && model.length > 0,
  );

  mergedSettings.defaultModel = getPreferredDefaultModel(
    mergedSettings,
    legacyDefaultCandidates[0] ?? "",
  );

  const projects = (Array.isArray(state.projects) ? state.projects : []).map(
    (project) => normalizeProject(project, mergedSettings),
  );
  const openProjectIds = new Set(projects.map((project) => project.id));
  const openProjectPathKeys = new Set(
    projects.map((project) => normalizeProjectPathKey(project.path)),
  );
  const closedProjects = (
    Array.isArray(state.closedProjects) ? state.closedProjects : []
  )
    .map((project) => normalizeProject(project, mergedSettings))
    .filter((project) => {
      if (openProjectIds.has(project.id)) {
        return false;
      }

      return !openProjectPathKeys.has(normalizeProjectPathKey(project.path));
    });
  const allProjects = [...projects, ...closedProjects];
  const projectsById = new Map(
    allProjects.map((project) => [project.id, project]),
  );
  const mergedPanelVisibility = {
    ...DEFAULT_PANEL_VISIBILITY,
    ...(legacyState.panelVisibility ?? {}),
    middle: true,
  };
  const mergedPanelSizes = normalizePanelSizes(legacyState.panelSizes);
  const rawProjectPanelSizesByProject =
    legacyState.projectPanelSizesByProject &&
    typeof legacyState.projectPanelSizesByProject === "object"
      ? legacyState.projectPanelSizesByProject
      : {};
  const rawProjectRightPanelOpenByProject =
    legacyState.projectRightPanelOpenByProject &&
    typeof legacyState.projectRightPanelOpenByProject === "object"
      ? legacyState.projectRightPanelOpenByProject
      : {};
  const rawProjectRightPanelViewByProject =
    legacyState.projectRightPanelViewByProject &&
    typeof legacyState.projectRightPanelViewByProject === "object"
      ? legacyState.projectRightPanelViewByProject
      : {};

  const rawChats = Array.isArray(state.chats)
    ? state.chats
    : Array.isArray((state as { threads?: unknown[] }).threads)
      ? ((state as { threads: ChatConfig[] }).threads ?? [])
      : [];
  const normalizedChats = rawChats
    .map((chat) => normalizeChat(chat, projectsById))
    .filter((chat): chat is ChatConfig => chat !== null);

  const legacyMessagesByChatId =
    state.messagesByChatId && typeof state.messagesByChatId === "object"
      ? state.messagesByChatId
      : state.chats &&
          !Array.isArray(state.chats) &&
          typeof state.chats === "object"
        ? (state.chats as Record<string, UIMessage[]>)
        : {};
  const messagesByChatId: Record<string, UIMessage[]> = {};
  const chats =
    normalizedChats.length > 0
      ? [...normalizedChats]
      : projects.map((project) => createChatConfig(project));
  const projectIdsWithChats = new Set(chats.map((chat) => chat.projectId));
  for (const project of projects) {
    if (!projectIdsWithChats.has(project.id)) {
      const chat = createChatConfig(project);
      chats.push(chat);
      projectIdsWithChats.add(project.id);
    }
  }

  for (const chat of chats) {
    const chatMessages = legacyMessagesByChatId[chat.id];
    if (isUiMessageArray(chatMessages)) {
      messagesByChatId[chat.id] = chatMessages;
      continue;
    }

    const legacyProjectMessages = legacyMessagesByChatId[chat.projectId];
    if (isUiMessageArray(legacyProjectMessages)) {
      messagesByChatId[chat.id] = legacyProjectMessages;
      continue;
    }

    messagesByChatId[chat.id] = [];
  }

  const applyProjectUi = (project: ProjectConfig): ProjectConfig => {
    const projectChats = chats.filter((chat) => chat.projectId === project.id);
    const legacyActiveChatId =
      legacyState.activeChatIdByProject?.[project.id] ??
      legacyState.activeThreadIdByProject?.[project.id] ??
      null;

    const requestedChatId =
      legacyActiveChatId ?? project.ui.activeChatId ?? null;
    const activeChatId = projectChats.some(
      (chat) => chat.id === requestedChatId,
    )
      ? requestedChatId
      : (projectChats[0]?.id ?? null);
    const legacyRightPanelOpen = rawProjectRightPanelOpenByProject[project.id];
    const legacyRightPanelView = rawProjectRightPanelViewByProject[project.id];

    return {
      ...project,
      ui: {
        ...project.ui,
        activeChatId,
        panelSizes: normalizePanelSizes(
          rawProjectPanelSizesByProject[project.id],
          project.ui.panelSizes ?? mergedPanelSizes,
        ),
        rightPanelOpen:
          typeof legacyRightPanelOpen === "boolean"
            ? legacyRightPanelOpen
            : (project.ui.rightPanelOpen ?? mergedPanelVisibility.right),
        rightPanelView: isRightPanelView(legacyRightPanelView)
          ? legacyRightPanelView
          : project.ui.rightPanelView,
      },
    };
  };

  const projectsWithUi = projects.map(applyProjectUi);
  const closedProjectsWithUi = closedProjects.map(applyProjectUi);
  const knownProjectIds = new Set(
    [...projectsWithUi, ...closedProjectsWithUi].map((project) => project.id),
  );
  const rawBrowserTabsByProject = normalizeBrowserTabsByProject(
    state.browserTabsByProject,
  );
  const browserTabsByProject = Object.fromEntries(
    Object.entries(rawBrowserTabsByProject).filter(([projectId]) =>
      knownProjectIds.has(projectId),
    ),
  );
  const activeBrowserTabIdByProject = normalizeActiveBrowserTabIds(
    state.activeBrowserTabIdByProject,
    browserTabsByProject,
  );

  return {
    activeProjectId:
      typeof state.activeProjectId === "string" ? state.activeProjectId : null,
    activeBrowserTabIdByProject,
    browserTabsByProject,
    chats,
    closedProjects: closedProjectsWithUi,
    messagesByChatId,
    projects: projectsWithUi,
    settings: mergedSettings,
    chatSort:
      state.chatSort === "createdDesc" ||
      state.chatSort === "createdAsc" ||
      state.chatSort === "titleAsc" ||
      (state as { threadSort?: string }).threadSort === "createdDesc" ||
      (state as { threadSort?: string }).threadSort === "createdAsc" ||
      (state as { threadSort?: string }).threadSort === "titleAsc"
        ? ((state.chatSort ??
            (state as { threadSort?: string })
              .threadSort) as PersistedIdeState["chatSort"])
        : "recent",
  };
};

export const ensureActiveProject = (
  projects: ProjectConfig[],
  activeProjectId: string | null,
) => {
  if (
    activeProjectId &&
    projects.some((project) => project.id === activeProjectId)
  ) {
    return activeProjectId;
  }

  return projects[0]?.id ?? null;
};

export const ensureActiveChatForProject = (
  chats: ChatConfig[],
  projectId: string,
  activeChatId: string | null,
) => {
  const projectChats = chats.filter(
    (chat) => chat.projectId === projectId && chat.deletedAt === null,
  );
  if (activeChatId && projectChats.some((chat) => chat.id === activeChatId)) {
    return activeChatId;
  }

  return projectChats[0]?.id ?? null;
};

export const getChatsForProject = (chats: ChatConfig[], projectId: string) =>
  chats.filter(
    (chat) => chat.projectId === projectId && chat.deletedAt === null,
  );

export const renderUserMessageText = (message: UIMessage): string => {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const sections: string[] = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }

    if (part.type === "text" && typeof part.text === "string") {
      const text = part.text.trim();
      if (text) {
        sections.push(text);
      }
      continue;
    }

    if (part.type === "file") {
      const label =
        (typeof part.filename === "string" && part.filename.trim()) ||
        (typeof part.mediaType === "string" && part.mediaType.trim()) ||
        "attachment";
      sections.push(`[Attached file: ${label}]`);
    }
  }

  return sections.join("\n\n");
};

export const stringifyPart = (
  value:
    | UIMessage
    | TextUIPart
    | ReasoningUIPart
    | ToolUIPart
    | DynamicToolUIPart
    | FileUIPart
    | SourceUrlUIPart
    | SourceDocumentUIPart
    | unknown,
) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
