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
  DEFAULT_PROVIDER,
  DEFAULT_SETTINGS,
  getPreferredDefaultModel,
  normalizeClaudeCodeModelId,
} from "@/lib/ide-defaults";
import type {
  AppSettings,
  ChatConfig,
  PersistedIdeState,
  ProjectConfig,
} from "@/types/ide";
import { dedupeModels, normalizeReasoningEffort } from "./ide-types";

export const emptyState: PersistedIdeState = {
  activeProjectId: null,
  activeChatIdByProject: {},
  chats: [],
  closedProjects: [],
  messagesByChatId: {},
  panelSizes: DEFAULT_PANEL_SIZES,
  panelVisibility: DEFAULT_PANEL_VISIBILITY,
  projectChatHistoryPanelOpenByProject: {},
  projectPanelSizesByProject: {},
  projectRightPanelOpenByProject: {},
  projects: [],
  settings: DEFAULT_SETTINGS,
  chatSort: "recent",
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
  return value === "anthropic" ? "anthropic" : DEFAULT_PROVIDER;
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
  };
  const rawMetadata =
    rawProject.metadata && typeof rawProject.metadata === "object"
      ? (rawProject.metadata as { icon?: unknown })
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

  const rawSettings = (state.settings ?? {}) as Partial<AppSettings> &
    Record<string, unknown>;

  const mergedSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    anthropicSelectedModels: dedupeModels(
      Array.isArray(rawSettings.anthropicSelectedModels)
        ? rawSettings.anthropicSelectedModels.map(normalizeClaudeCodeModelId)
        : [],
    ),
    defaultModel:
      typeof rawSettings.defaultModel === "string"
        ? rawSettings.defaultModel
        : "",
    expandEditToolParts:
      typeof rawSettings.expandEditToolParts === "boolean"
        ? rawSettings.expandEditToolParts
        : DEFAULT_SETTINGS.expandEditToolParts,
    expandShellToolParts:
      typeof rawSettings.expandShellToolParts === "boolean"
        ? rawSettings.expandShellToolParts
        : DEFAULT_SETTINGS.expandShellToolParts,
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
    ...(state.panelVisibility ?? {}),
    middle: true,
  };
  const mergedPanelSizes = normalizePanelSizes(state.panelSizes);
  const rawProjectPanelSizesByProject =
    state.projectPanelSizesByProject &&
    typeof state.projectPanelSizesByProject === "object"
      ? state.projectPanelSizesByProject
      : {};
  const projectPanelSizesByProject = Object.fromEntries(
    allProjects.map((project) => [
      project.id,
      normalizePanelSizes(
        rawProjectPanelSizesByProject[project.id],
        mergedPanelSizes,
      ),
    ]),
  );
  const rawProjectChatHistoryPanelOpenByProject =
    state.projectChatHistoryPanelOpenByProject &&
    typeof state.projectChatHistoryPanelOpenByProject === "object"
      ? state.projectChatHistoryPanelOpenByProject
      : {};
  const projectChatHistoryPanelOpenByProject = Object.fromEntries(
    allProjects.map((project) => [
      project.id,
      typeof rawProjectChatHistoryPanelOpenByProject[project.id] === "boolean"
        ? rawProjectChatHistoryPanelOpenByProject[project.id]
        : mergedPanelVisibility.left,
    ]),
  );
  const rawProjectRightPanelOpenByProject =
    state.projectRightPanelOpenByProject &&
    typeof state.projectRightPanelOpenByProject === "object"
      ? state.projectRightPanelOpenByProject
      : {};
  const projectRightPanelOpenByProject = Object.fromEntries(
    allProjects.map((project) => [
      project.id,
      typeof rawProjectRightPanelOpenByProject[project.id] === "boolean"
        ? rawProjectRightPanelOpenByProject[project.id]
        : mergedPanelVisibility.right,
    ]),
  );

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

  const activeChatIdByProject = allProjects.reduce<
    Record<string, string | null>
  >((acc, project) => {
    const projectChats = chats.filter((chat) => chat.projectId === project.id);
    if (projectChats.length === 0) {
      acc[project.id] = null;
      return acc;
    }

    const requestedChatId =
      state.activeChatIdByProject?.[project.id] ??
      (state as { activeThreadIdByProject?: Record<string, string | null> })
        .activeThreadIdByProject?.[project.id] ??
      null;
    acc[project.id] = projectChats.some((chat) => chat.id === requestedChatId)
      ? requestedChatId
      : (projectChats[0]?.id ?? null);
    return acc;
  }, {});

  return {
    activeProjectId:
      typeof state.activeProjectId === "string" ? state.activeProjectId : null,
    activeChatIdByProject,
    chats,
    closedProjects,
    messagesByChatId,
    panelSizes: mergedPanelSizes,
    panelVisibility: mergedPanelVisibility,
    projectChatHistoryPanelOpenByProject,
    projectPanelSizesByProject,
    projectRightPanelOpenByProject,
    projects,
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
