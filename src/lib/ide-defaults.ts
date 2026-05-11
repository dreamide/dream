import { createModelOption, type ModelOption } from "@/lib/models";
import type {
  AiProvider,
  AppSettings,
  ChatConfig,
  PanelSizes,
  PanelVisibility,
  PersistedIdeState,
  ProjectConfig,
  ProjectUiState,
} from "@/types/ide";

export const DEFAULT_PROVIDER: AiProvider = "openai";
export const ALL_PROVIDERS: AiProvider[] = ["openai", "anthropic"];
export const CLAUDE_CODE_MODEL_IDS = {
  haiku: "haiku",
  opus: "opus",
  sonnet: "sonnet",
} as const;

export const normalizeClaudeCodeModelId = (modelId: string): string => {
  const trimmed = modelId.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes("opus")) {
    return CLAUDE_CODE_MODEL_IDS.opus;
  }
  if (trimmed.includes("haiku")) {
    return CLAUDE_CODE_MODEL_IDS.haiku;
  }
  if (trimmed.includes("sonnet")) {
    return CLAUDE_CODE_MODEL_IDS.sonnet;
  }
  return trimmed;
};

export const DEFAULT_SETTINGS: AppSettings = {
  anthropicSelectedModels: [],
  autoAcceptPermissions: false,
  defaultModel: "",
  expandToolCalls: false,
  groupToolCalls: false,
  openAiSelectedModels: [],
  showReasoningSummaries: true,
  shellPath: "",
};

export const DEFAULT_PANEL_VISIBILITY: PanelVisibility = {
  left: false,
  middle: true,
  right: true,
};

export const DEFAULT_PANEL_SIZES: PanelSizes = {
  chatHistoryPanelWidth: 400,
  leftSidebarWidth: 240,
  rightPanelWidth: 520,
  terminalHeight: 260,
};

export const DEFAULT_PROJECT_UI: ProjectUiState = {
  activeChatId: null,
  openChatIds: [],
  chatColumnWidths: {},
  chatHistoryPanelOpen: false,
  multiChat: false,
  panelSizes: DEFAULT_PANEL_SIZES,
  rightPanelOpen: DEFAULT_PANEL_VISIBILITY.right,
  rightPanelView: "changes",
};

export const createEmptyState = (): PersistedIdeState => ({
  activeProjectId: null,
  activeBrowserTabIdByProject: {},
  browserTabsByProject: {},
  chats: [],
  closedProjects: [],
  messagesByChatId: {},
  projects: [],
  settings: DEFAULT_SETTINGS,
  chatSort: "recent",
});

export const createProjectConfig = (
  path: string,
  settings: AppSettings,
): ProjectConfig => {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "project";
  const defaultSelection = getDefaultModelSelection(settings);

  return {
    id: crypto.randomUUID(),
    icon: null,
    model: defaultSelection.model,
    modelSpeed: "standard",
    name,
    path,
    browserUrl: "http://127.0.0.1:3000",
    provider: defaultSelection.provider,
    reasoningEffort: "medium",
    runCommand: "pnpm dev",
    ui: {
      ...DEFAULT_PROJECT_UI,
      rightPanelOpen: false,
    },
  };
};

export const createChatConfig = (
  project: ProjectConfig,
  overrides?: Partial<
    Pick<
      ChatConfig,
      | "agentMode"
      | "model"
      | "modelSpeed"
      | "provider"
      | "reasoningEffort"
      | "title"
    >
  >,
): ChatConfig => {
  const timestamp = new Date().toISOString();

  return {
    agentMode: overrides?.agentMode ?? "build",
    createdAt: timestamp,
    deletedAt: null,
    id: crypto.randomUUID(),
    model: overrides?.model ?? project.model,
    modelSpeed: overrides?.modelSpeed ?? project.modelSpeed,
    projectId: project.id,
    provider: overrides?.provider ?? project.provider,
    reasoningEffort: overrides?.reasoningEffort ?? project.reasoningEffort,
    remoteConversationId: null,
    remoteConversationModel: null,
    remoteConversationModelSpeed: null,
    remoteConversationProjectPath: null,
    title: overrides?.title?.trim() || "New chat",
    updatedAt: timestamp,
  };
};

export const getConnectedProviders = (settings: AppSettings): AiProvider[] => {
  return ALL_PROVIDERS.filter(
    (provider) => getModelsForProvider(provider, settings).length > 0,
  );
};

export const getDefaultModelForProvider = (
  provider: AiProvider,
  settings: AppSettings,
): string => {
  const providerModels = getModelsForProvider(provider, settings);
  const defaultSelection = getDefaultModelSelection(settings);

  if (
    defaultSelection.provider === provider &&
    providerModels.includes(defaultSelection.model)
  ) {
    return defaultSelection.model;
  }

  return providerModels[0] ?? "";
};

export const getModelsForProvider = (
  provider: AiProvider,
  settings: AppSettings,
): string[] => {
  const clean = (models: string[]): string[] => {
    return Array.from(
      new Set(models.map((model) => model.trim()).filter(Boolean)),
    );
  };

  if (provider === "anthropic") {
    return clean(
      settings.anthropicSelectedModels.map(normalizeClaudeCodeModelId),
    );
  }

  return clean(settings.openAiSelectedModels);
};

const getDefaultModelCandidates = (modelId: string): string[] => {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return [];
  }

  return Array.from(
    new Set([trimmed, normalizeClaudeCodeModelId(trimmed)].filter(Boolean)),
  );
};

const getFirstAvailableModel = (settings: AppSettings): string => {
  for (const provider of getConnectedProviders(settings)) {
    const model = getModelsForProvider(provider, settings)[0];
    if (model) {
      return model;
    }
  }

  return "";
};

export const getProviderForModel = (
  modelId: string,
  settings: AppSettings,
): AiProvider | null => {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return null;
  }

  const anthropicModelId = normalizeClaudeCodeModelId(trimmed);

  for (const provider of getConnectedProviders(settings)) {
    const providerModels = getModelsForProvider(provider, settings);
    const candidate = provider === "anthropic" ? anthropicModelId : trimmed;
    if (providerModels.includes(candidate)) {
      return provider;
    }
  }

  return null;
};

export const getPreferredDefaultModel = (
  settings: AppSettings,
  preferredModel = settings.defaultModel,
): string => {
  for (const candidate of getDefaultModelCandidates(preferredModel)) {
    if (getProviderForModel(candidate, settings)) {
      return candidate;
    }
  }

  return getFirstAvailableModel(settings);
};

export const getDefaultModelSelection = (
  settings: AppSettings,
): { model: string; provider: AiProvider } => {
  const model = getPreferredDefaultModel(settings);
  const provider =
    getProviderForModel(model, settings) ??
    getConnectedProviders(settings)[0] ??
    DEFAULT_PROVIDER;

  return { model, provider };
};

export const getModelOptionsForProvider = (
  provider: AiProvider,
  settings: AppSettings,
  availableModels: ModelOption[] = [],
): ModelOption[] => {
  const selectedIds = getModelsForProvider(provider, settings);
  const modelsById = new Map(availableModels.map((model) => [model.id, model]));

  return selectedIds.map(
    (id) => modelsById.get(id) ?? createModelOption(provider, id),
  );
};
