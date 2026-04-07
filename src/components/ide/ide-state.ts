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
  createThreadConfig,
  DEFAULT_PANEL_SIZES,
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_SETTINGS,
  getPreferredDefaultModel,
  normalizeClaudeCodeModelId,
} from "@/lib/ide-defaults";
import type {
  AppSettings,
  PersistedIdeState,
  ProjectConfig,
  ThreadConfig,
} from "@/types/ide";
import {
  dedupeModels,
  inferConnectedProviders,
  normalizeChatMode,
  normalizeReasoningEffort,
} from "./ide-types";

export const emptyState: PersistedIdeState = {
  activeProjectId: null,
  activeThreadIdByProject: {},
  chats: {},
  panelSizes: DEFAULT_PANEL_SIZES,
  panelVisibility: DEFAULT_PANEL_VISIBILITY,
  projects: [],
  settings: DEFAULT_SETTINGS,
  threadSort: "recent",
  threads: [],
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

const normalizeThread = (
  thread: ThreadConfig,
  projectsById: Map<string, ProjectConfig>,
): ThreadConfig | null => {
  const project = projectsById.get(thread.projectId);
  if (!project) {
    return null;
  }

  const title = typeof thread.title === "string" ? thread.title.trim() : "";
  const createdAt =
    typeof thread.createdAt === "string" && thread.createdAt.trim().length > 0
      ? thread.createdAt
      : new Date().toISOString();
  const updatedAt =
    typeof thread.updatedAt === "string" && thread.updatedAt.trim().length > 0
      ? thread.updatedAt
      : createdAt;
  const provider =
    thread.provider === "anthropic" ||
    thread.provider === "gemini" ||
    thread.provider === "openai"
      ? thread.provider
      : project.provider;
  const model =
    typeof thread.model === "string"
      ? provider === "anthropic"
        ? normalizeClaudeCodeModelId(thread.model)
        : thread.model
      : project.model;

  return {
    ...thread,
    archivedAt:
      typeof thread.archivedAt === "string" &&
      thread.archivedAt.trim().length > 0
        ? thread.archivedAt
        : null,
    chatMode: normalizeChatMode(
      (thread as unknown as Record<string, unknown>).chatMode,
    ),
    createdAt,
    model,
    provider,
    reasoningEffort: normalizeReasoningEffort(thread.reasoningEffort),
    remoteConversationId:
      typeof thread.remoteConversationId === "string" &&
      thread.remoteConversationId.trim().length > 0
        ? thread.remoteConversationId
        : null,
    title: title || "New thread",
    updatedAt,
  };
};

export const mergePersistedState = (
  state: Partial<PersistedIdeState> | null | undefined,
): PersistedIdeState => {
  if (!state) {
    return emptyState;
  }

  const projects = (Array.isArray(state.projects) ? state.projects : []).map(
    (project) => ({
      ...project,
      reasoningEffort: normalizeReasoningEffort(project.reasoningEffort),
    }),
  );
  const projectsById = new Map(
    projects.map((project) => [project.id, project]),
  );
  const rawSettings = (state.settings ?? {}) as Partial<AppSettings>;
  const rawSettingsRecord = rawSettings as Record<string, unknown>;
  const hasExplicitConnectedProviders = Object.hasOwn(
    rawSettings,
    "connectedProviders",
  );
  const mergedSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...rawSettings,
  };

  if ((mergedSettings.openAiAuthMode as string) === "oauth") {
    mergedSettings.openAiAuthMode = "codex";
  }

  if (
    mergedSettings.openAiAuthMode !== "apiKey" &&
    mergedSettings.openAiAuthMode !== "codex"
  ) {
    mergedSettings.openAiAuthMode = "apiKey";
  }

  if ((rawSettings.anthropicAuthMode as string) === "claudeProMax") {
    mergedSettings.anthropicAuthMode = "claudeCode";
  }

  if (
    mergedSettings.anthropicAuthMode !== "apiKey" &&
    mergedSettings.anthropicAuthMode !== "claudeCode"
  ) {
    mergedSettings.anthropicAuthMode = "apiKey";
  }

  mergedSettings.anthropicAccessToken =
    typeof mergedSettings.anthropicAccessToken === "string"
      ? mergedSettings.anthropicAccessToken
      : "";
  mergedSettings.anthropicRefreshToken =
    typeof mergedSettings.anthropicRefreshToken === "string"
      ? mergedSettings.anthropicRefreshToken
      : "";
  mergedSettings.anthropicAccessTokenExpiresAt =
    typeof mergedSettings.anthropicAccessTokenExpiresAt === "number"
      ? mergedSettings.anthropicAccessTokenExpiresAt
      : null;
  mergedSettings.geminiApiKey =
    typeof mergedSettings.geminiApiKey === "string"
      ? mergedSettings.geminiApiKey
      : "";

  const openAiSelectedModels = dedupeModels(
    Array.isArray(mergedSettings.openAiSelectedModels)
      ? mergedSettings.openAiSelectedModels
      : [],
  );
  mergedSettings.openAiSelectedModels = openAiSelectedModels;

  const anthropicSelectedModels = dedupeModels(
    Array.isArray(mergedSettings.anthropicSelectedModels)
      ? mergedSettings.anthropicSelectedModels.map(normalizeClaudeCodeModelId)
      : [],
  );
  mergedSettings.anthropicSelectedModels = anthropicSelectedModels;

  const geminiSelectedModels = dedupeModels(
    Array.isArray(mergedSettings.geminiSelectedModels)
      ? mergedSettings.geminiSelectedModels
      : [],
  );
  mergedSettings.geminiSelectedModels = geminiSelectedModels;

  mergedSettings.connectedProviders = inferConnectedProviders(
    mergedSettings,
    hasExplicitConnectedProviders,
  );

  const legacyDefaultModelCandidates = [
    typeof rawSettingsRecord.defaultModel === "string"
      ? rawSettingsRecord.defaultModel
      : "",
    ...mergedSettings.connectedProviders.map((provider) => {
      if (provider === "anthropic") {
        return typeof rawSettingsRecord.defaultAnthropicModel === "string"
          ? normalizeClaudeCodeModelId(rawSettingsRecord.defaultAnthropicModel)
          : "";
      }

      if (provider === "gemini") {
        return typeof rawSettingsRecord.defaultGeminiModel === "string"
          ? rawSettingsRecord.defaultGeminiModel
          : "";
      }

      return typeof rawSettingsRecord.defaultOpenAiModel === "string"
        ? rawSettingsRecord.defaultOpenAiModel
        : "";
    }),
  ];

  mergedSettings.defaultModel = getPreferredDefaultModel(
    mergedSettings,
    legacyDefaultModelCandidates.find(
      (model): model is string => typeof model === "string" && model.length > 0,
    ) ?? "",
  );

  const rawThreads = Array.isArray(state.threads) ? state.threads : [];
  const normalizedThreads = rawThreads
    .map((thread) => normalizeThread(thread, projectsById))
    .filter((thread): thread is ThreadConfig => thread !== null);

  const legacyChats =
    state.chats && typeof state.chats === "object" ? state.chats : {};
  const chats: Record<string, UIMessage[]> = {};
  const threads =
    normalizedThreads.length > 0
      ? normalizedThreads
      : projects.map((project) => createThreadConfig(project));

  for (const thread of threads) {
    const threadMessages = legacyChats[thread.id];
    if (isUiMessageArray(threadMessages)) {
      chats[thread.id] = threadMessages;
      continue;
    }

    const legacyProjectMessages = legacyChats[thread.projectId];
    if (isUiMessageArray(legacyProjectMessages)) {
      chats[thread.id] = legacyProjectMessages;
      continue;
    }

    chats[thread.id] = [];
  }

  const activeThreadIdByProject = projects.reduce<
    Record<string, string | null>
  >((acc, project) => {
    const projectThreads = threads.filter(
      (thread) => thread.projectId === project.id,
    );
    if (projectThreads.length === 0) {
      acc[project.id] = null;
      return acc;
    }

    const requestedThreadId =
      state.activeThreadIdByProject?.[project.id] ?? null;
    acc[project.id] = projectThreads.some(
      (thread) => thread.id === requestedThreadId,
    )
      ? requestedThreadId
      : (projectThreads[0]?.id ?? null);
    return acc;
  }, {});

  return {
    activeProjectId:
      typeof state.activeProjectId === "string" ? state.activeProjectId : null,
    activeThreadIdByProject,
    chats,
    panelSizes: {
      leftSidebarWidth: normalizePanelSize(
        state.panelSizes?.leftSidebarWidth,
        DEFAULT_PANEL_SIZES.leftSidebarWidth,
        160,
      ),
      rightPanelWidth: normalizePanelSize(
        state.panelSizes?.rightPanelWidth,
        DEFAULT_PANEL_SIZES.rightPanelWidth,
        200,
      ),
      terminalHeight: normalizePanelSize(
        state.panelSizes?.terminalHeight,
        DEFAULT_PANEL_SIZES.terminalHeight,
        120,
      ),
    },
    panelVisibility: {
      ...DEFAULT_PANEL_VISIBILITY,
      ...(state.panelVisibility ?? {}),
    },
    projects,
    settings: mergedSettings,
    threadSort:
      state.threadSort === "createdDesc" ||
      state.threadSort === "createdAsc" ||
      state.threadSort === "titleAsc"
        ? state.threadSort
        : "recent",
    threads,
  };
};

export const ensureActiveProject = (
  projects: ProjectConfig[],
  activeProjectId: string | null,
): string | null => {
  if (projects.length === 0) {
    return null;
  }

  if (
    activeProjectId &&
    projects.some((project) => project.id === activeProjectId)
  ) {
    return activeProjectId;
  }

  return projects[0]?.id ?? null;
};

export const getThreadsForProject = (
  threads: ThreadConfig[],
  projectId: string,
): ThreadConfig[] => {
  const projectThreads = threads.filter(
    (thread) => thread.projectId === projectId && thread.archivedAt === null,
  );

  return projectThreads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
};

export const ensureActiveThreadForProject = (
  threads: ThreadConfig[],
  projectId: string,
  activeThreadId: string | null,
): string | null => {
  const projectThreads = getThreadsForProject(threads, projectId);
  if (projectThreads.length === 0) {
    return null;
  }

  if (
    activeThreadId &&
    projectThreads.some((thread) => thread.id === activeThreadId)
  ) {
    return activeThreadId;
  }

  return projectThreads[0]?.id ?? null;
};

export const renderUserMessageText = (message: UIMessage): string => {
  return message.parts
    .flatMap((part) => {
      if (part.type !== "text") {
        return [];
      }

      return [part.text];
    })
    .join("\n")
    .trim();
};

export const stringifyPart = (
  part:
    | unknown
    | DynamicToolUIPart
    | FileUIPart
    | ReasoningUIPart
    | SourceDocumentUIPart
    | SourceUrlUIPart
    | TextUIPart
    | ToolUIPart,
): string => {
  try {
    return JSON.stringify(part, null, 2);
  } catch {
    return "[unserializable part]";
  }
};
