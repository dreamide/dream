import {
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type {
  AppSettings,
  PersistedIdeState,
  ProjectConfig,
} from "@/types/ide";
import type {
  DynamicToolUIPart,
  FileUIPart,
  ReasoningUIPart,
  SourceDocumentUIPart,
  SourceUrlUIPart,
  TextUIPart,
  ToolUIPart,
} from "ai";
import type { UIMessage } from "ai";
import {
  dedupeModels,
  inferConnectedProviders,
  normalizeReasoningEffort,
} from "./ide-types";

export const emptyState: PersistedIdeState = {
  activeProjectId: null,
  chats: {},
  panelVisibility: DEFAULT_PANEL_VISIBILITY,
  projects: [],
  settings: DEFAULT_SETTINGS,
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
  const rawSettings = (state.settings ?? {}) as Partial<AppSettings>;
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

  const openAiSelectedModels = dedupeModels(
    Array.isArray(mergedSettings.openAiSelectedModels)
      ? mergedSettings.openAiSelectedModels
      : [],
  );
  mergedSettings.openAiSelectedModels = openAiSelectedModels;

  if (
    !mergedSettings.openAiSelectedModels.includes(
      mergedSettings.defaultOpenAiModel,
    )
  ) {
    mergedSettings.defaultOpenAiModel =
      mergedSettings.openAiSelectedModels[0] ?? "";
  }

  const anthropicSelectedModels = dedupeModels(
    Array.isArray(mergedSettings.anthropicSelectedModels)
      ? mergedSettings.anthropicSelectedModels
      : [],
  );
  mergedSettings.anthropicSelectedModels = anthropicSelectedModels;

  if (
    !mergedSettings.anthropicSelectedModels.includes(
      mergedSettings.defaultAnthropicModel,
    )
  ) {
    mergedSettings.defaultAnthropicModel =
      mergedSettings.anthropicSelectedModels[0] ?? "";
  }

  mergedSettings.connectedProviders = inferConnectedProviders(
    mergedSettings,
    hasExplicitConnectedProviders,
  );

  return {
    activeProjectId:
      typeof state.activeProjectId === "string" ? state.activeProjectId : null,
    chats: state.chats ?? {},
    panelVisibility: {
      ...DEFAULT_PANEL_VISIBILITY,
      ...(state.panelVisibility ?? {}),
    },
    projects,
    settings: mergedSettings,
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
