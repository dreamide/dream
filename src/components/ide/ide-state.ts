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
  DEFAULT_PROVIDER,
  getPreferredDefaultModel,
  normalizeClaudeCodeModelId,
} from "@/lib/ide-defaults";
import type {
  AppSettings,
  PersistedIdeState,
  ProjectConfig,
  ThreadConfig,
} from "@/types/ide";
import { dedupeModels, normalizeChatMode, normalizeReasoningEffort } from "./ide-types";

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

const normalizeProvider = (value: unknown): "openai" | "anthropic" => {
  return value === "anthropic" ? "anthropic" : DEFAULT_PROVIDER;
};

const normalizeProject = (
  project: ProjectConfig,
  settings: AppSettings,
): ProjectConfig => {
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
    model: model || defaultModel,
    provider,
    reasoningEffort: normalizeReasoningEffort(project.reasoningEffort),
  };
};

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
  const provider = normalizeProvider(thread.provider);
  const model =
    typeof thread.model === "string"
      ? provider === "anthropic"
        ? normalizeClaudeCodeModelId(thread.model)
        : thread.model.trim()
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
    model: model || project.model,
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
    openAiSelectedModels: dedupeModels(
      Array.isArray(rawSettings.openAiSelectedModels)
        ? rawSettings.openAiSelectedModels
        : [],
    ),
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
  ].filter((model): model is string => typeof model === "string" && model.length > 0);

  mergedSettings.defaultModel = getPreferredDefaultModel(
    mergedSettings,
    legacyDefaultCandidates[0] ?? "",
  );

  const projects = (Array.isArray(state.projects) ? state.projects : []).map(
    (project) => normalizeProject(project, mergedSettings),
  );
  const projectsById = new Map(
    projects.map((project) => [project.id, project]),
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
) => {
  if (activeProjectId && projects.some((project) => project.id === activeProjectId)) {
    return activeProjectId;
  }

  return projects[0]?.id ?? null;
};

export const ensureActiveThreadForProject = (
  threads: ThreadConfig[],
  projectId: string,
  activeThreadId: string | null,
) => {
  const projectThreads = threads.filter((thread) => thread.projectId === projectId);
  if (
    activeThreadId &&
    projectThreads.some((thread) => thread.id === activeThreadId)
  ) {
    return activeThreadId;
  }

  return projectThreads[0]?.id ?? null;
};

export const getThreadsForProject = (
  threads: ThreadConfig[],
  projectId: string,
) => threads.filter((thread) => thread.projectId === projectId);

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
