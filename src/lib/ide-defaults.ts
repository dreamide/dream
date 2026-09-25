import {
  createModelOption,
  type ModelOption,
  normalizeModelSpeed,
} from "@/lib/models";
import { DEFAULT_SPARKLES_PALETTE } from "@/lib/sparkles-palettes";
import type {
  AiProvider,
  AppSettings,
  ChatConfig,
  ModelSpeed,
  PanelSizes,
  PanelVisibility,
  PersistedIdeState,
  ProjectConfig,
  ProjectUiState,
  ReasoningEffort,
  SavedPrompt,
  StashItem,
} from "@/types/ide";

export const DEFAULT_PROVIDER: AiProvider = "openai";
export const ALL_PROVIDERS: AiProvider[] = [
  "openai",
  "anthropic",
  "opencode",
  "cursor",
  "grok",
];
export const CLAUDE_CODE_MODEL_IDS = {
  haiku: "haiku",
  opusOneMillion: "opus[1m]",
  opus: "opus",
  sonnetOneMillion: "sonnet[1m]",
  sonnet: "sonnet",
} as const;

export const normalizeClaudeCodeModelId = (modelId: string): string => {
  const trimmed = modelId.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("claude-")) {
    return trimmed;
  }
  const usesOneMillionContext = /\[1m\]/i.test(trimmed);
  if (trimmed.includes("opus")) {
    return usesOneMillionContext
      ? CLAUDE_CODE_MODEL_IDS.opusOneMillion
      : CLAUDE_CODE_MODEL_IDS.opus;
  }
  if (trimmed.includes("haiku")) {
    return CLAUDE_CODE_MODEL_IDS.haiku;
  }
  if (trimmed.includes("sonnet")) {
    return usesOneMillionContext
      ? CLAUDE_CODE_MODEL_IDS.sonnetOneMillion
      : CLAUDE_CODE_MODEL_IDS.sonnet;
  }
  return trimmed;
};

export const DEFAULT_SETTINGS: AppSettings = {
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
  changesDiffWordWrap: false,
  fileEditorWordWrap: false,
  multiChat: false,
  panelSizes: DEFAULT_PANEL_SIZES,
  rightPanelOpen: DEFAULT_PANEL_VISIBILITY.right,
  rightPanelView: "changes",
  stashItems: [],
};

export const createEmptyState = (): PersistedIdeState => ({
  activeProjectId: null,
  appView: "code",
  savedPrompts: [],
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
  const timestamp = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    icon: null,
    lastUsedAt: timestamp,
    model: defaultSelection.model,
    modelSpeed: defaultSelection.modelSpeed,
    name,
    path,
    browserUrl: "",
    provider: defaultSelection.provider,
    reasoningEffort: defaultSelection.reasoningEffort,
    runCommand: "pnpm dev",
    ui: {
      ...DEFAULT_PROJECT_UI,
      rightPanelOpen: false,
      stashItems: [],
    },
    worktree: null,
  };
};

export const createChatConfig = (
  project: ProjectConfig,
  overrides?: Partial<
    Pick<
      ChatConfig,
      | "model"
      | "modelSpeed"
      | "permissionMode"
      | "provider"
      | "reasoningEffort"
      | "title"
    >
  >,
): ChatConfig => {
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

export const createStashItem = (
  project: ProjectConfig,
  overrides?: Partial<
    Pick<
      StashItem,
      | "model"
      | "modelSpeed"
      | "permissionMode"
      | "provider"
      | "reasoningEffort"
      | "references"
      | "text"
    >
  >,
): StashItem => {
  const timestamp = new Date().toISOString();

  return {
    createdAt: timestamp,
    id: crypto.randomUUID(),
    model: overrides?.model ?? project.model,
    modelSpeed: overrides?.modelSpeed ?? project.modelSpeed,
    permissionMode: overrides?.permissionMode ?? "full-access",
    provider: overrides?.provider ?? project.provider,
    reasoningEffort:
      overrides && "reasoningEffort" in overrides
        ? (overrides.reasoningEffort ?? null)
        : project.reasoningEffort,
    references: overrides?.references ?? [],
    text: overrides?.text ?? "",
    updatedAt: timestamp,
  };
};

export const createSavedPrompt = (
  values: Pick<SavedPrompt, "name" | "prompt">,
): SavedPrompt => {
  const timestamp = new Date().toISOString();

  return {
    createdAt: timestamp,
    id: crypto.randomUUID(),
    prompt: values.prompt.trim(),
    name: values.name.trim(),
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

export const isProviderEnabled = (
  provider: AiProvider,
  settings: AppSettings,
): boolean => !settings.disabledProviders?.includes(provider);

/**
 * Models offered for a provider. A disabled provider offers none, which hides
 * it everywhere a model can be picked.
 */
export const getModelsForProvider = (
  provider: AiProvider,
  settings: AppSettings,
): string[] => {
  if (!isProviderEnabled(provider, settings)) {
    return [];
  }

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

  if (provider === "opencode") {
    return clean(settings.openCodeSelectedModels);
  }

  if (provider === "cursor") {
    return clean(settings.cursorSelectedModels);
  }

  if (provider === "grok") {
    return clean(settings.grokSelectedModels);
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

const isReasoningEffort = (value: unknown): value is ReasoningEffort =>
  ["low", "medium", "high", "xhigh", "max"].includes(value as string);

export const resolveModelSpeedForModel = (
  value: unknown,
  availableModelSpeedTiers: ModelSpeed[],
): ModelSpeed => {
  const normalized = normalizeModelSpeed(value);

  return availableModelSpeedTiers.length > 0 &&
    availableModelSpeedTiers.includes(normalized)
    ? normalized
    : "standard";
};

export const resolveReasoningEffortForModel = (
  value: unknown,
  availableReasoningEfforts: ReasoningEffort[],
): ReasoningEffort | null => {
  if (availableReasoningEfforts.length === 0) {
    return null;
  }

  const selected =
    isReasoningEffort(value) && availableReasoningEfforts.includes(value)
      ? value
      : availableReasoningEfforts.includes("medium")
        ? "medium"
        : (availableReasoningEfforts[0] ?? null);

  return selected === "medium" ? null : selected;
};

export const getDefaultModelSelection = (
  settings: AppSettings,
): {
  model: string;
  modelSpeed: ModelSpeed;
  provider: AiProvider;
  reasoningEffort: ReasoningEffort | null;
} => {
  const model = getPreferredDefaultModel(settings);
  const provider =
    getProviderForModel(model, settings) ??
    getConnectedProviders(settings)[0] ??
    DEFAULT_PROVIDER;

  return {
    model,
    modelSpeed: normalizeModelSpeed(settings.defaultModelSpeed),
    provider,
    reasoningEffort: isReasoningEffort(settings.defaultReasoningEffort)
      ? settings.defaultReasoningEffort
      : null,
  };
};

export const getDefaultGitGenerationModelSelection = (
  settings: AppSettings,
): {
  model: string;
  modelSpeed: ModelSpeed;
  provider: AiProvider;
  reasoningEffort: ReasoningEffort | null;
} => {
  const model = getPreferredDefaultModel(
    settings,
    settings.defaultGitGenerationModel || settings.defaultModel,
  );
  const provider =
    getProviderForModel(model, settings) ??
    getConnectedProviders(settings)[0] ??
    DEFAULT_PROVIDER;

  return {
    model,
    modelSpeed: normalizeModelSpeed(settings.defaultGitGenerationModelSpeed),
    provider,
    reasoningEffort: isReasoningEffort(
      settings.defaultGitGenerationReasoningEffort,
    )
      ? settings.defaultGitGenerationReasoningEffort
      : null,
  };
};

export const normalizeDefaultModelSettings = (
  settings: AppSettings,
  preferredModel = settings.defaultModel,
): AppSettings => {
  const defaultModel = getPreferredDefaultModel(settings, preferredModel);
  const defaultSelection = getDefaultModelSelection({
    ...settings,
    defaultModel,
  });

  return {
    ...settings,
    defaultGitGenerationModel: getPreferredDefaultModel(
      settings,
      settings.defaultGitGenerationModel || defaultModel,
    ),
    defaultModel,
    defaultModelSpeed: defaultSelection.modelSpeed,
    defaultReasoningEffort: defaultSelection.reasoningEffort,
  };
};

export const getModelOptionsForProvider = (
  provider: AiProvider,
  settings: AppSettings,
  availableModels: ModelOption[] = [],
): ModelOption[] => {
  const selectedIds = getModelsForProvider(provider, settings);
  const modelsById = new Map(availableModels.map((model) => [model.id, model]));
  const selectedIdSet = new Set(selectedIds);
  const orderedModels = availableModels.filter((model) =>
    selectedIdSet.has(model.id),
  );
  const orderedModelIds = new Set(orderedModels.map((model) => model.id));
  const unknownModels = selectedIds
    .filter((id) => !orderedModelIds.has(id))
    .map((id) => createModelOption(provider, id));

  return [
    ...orderedModels.map((model) => modelsById.get(model.id) ?? model),
    ...unknownModels,
  ];
};
