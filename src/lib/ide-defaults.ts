import { createModelOption, type ModelOption } from "@/lib/models";
import type {
  AiProvider,
  AppSettings,
  PanelSizes,
  PanelVisibility,
  PersistedIdeState,
  ProjectConfig,
  ProviderAuthMode,
  ThreadConfig,
} from "@/types/ide";

export const DEFAULT_PROVIDER: AiProvider = "openai";
const ALL_PROVIDERS: AiProvider[] = ["openai", "anthropic", "gemini"];
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
  anthropicAccessToken: "",
  anthropicAccessTokenExpiresAt: null,
  anthropicAuthMode: "apiKey",
  anthropicApiKey: "",
  anthropicRefreshToken: "",
  anthropicSelectedModels: [],
  connectedProviders: [],
  defaultModel: "",
  geminiApiKey: "",
  geminiSelectedModels: [],
  openAiAuthMode: "apiKey",
  openAiApiKey: "",
  openAiSelectedModels: [],
  shellPath: "",
};

export const DEFAULT_PANEL_VISIBILITY: PanelVisibility = {
  left: true,
  middle: true,
  right: true,
};

export const DEFAULT_PANEL_SIZES: PanelSizes = {
  leftSidebarWidth: 240,
  rightPanelWidth: 520,
  terminalHeight: 260,
};

export const createEmptyState = (): PersistedIdeState => ({
  activeProjectId: null,
  activeThreadIdByProject: {},
  chats: {},
  panelSizes: DEFAULT_PANEL_SIZES,
  panelVisibility: DEFAULT_PANEL_VISIBILITY,
  projects: [],
  settings: DEFAULT_SETTINGS,
  threadSort: "recent",
  threads: [],
});

export const createProjectConfig = (
  path: string,
  settings: AppSettings,
): ProjectConfig => {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "project";
  const defaultSelection = getDefaultModelSelection(settings);

  return {
    id: crypto.randomUUID(),
    model: defaultSelection.model,
    name,
    path,
    previewUrl: "http://127.0.0.1:3000",
    provider: defaultSelection.provider,
    reasoningEffort: "medium",
    runCommand: "pnpm dev",
  };
};

export const createThreadConfig = (
  project: ProjectConfig,
  overrides?: Partial<
    Pick<
      ThreadConfig,
      "chatMode" | "model" | "provider" | "reasoningEffort" | "title"
    >
  >,
): ThreadConfig => {
  const timestamp = new Date().toISOString();

  return {
    archivedAt: null,
    chatMode: overrides?.chatMode ?? "build",
    createdAt: timestamp,
    id: crypto.randomUUID(),
    model: overrides?.model ?? project.model,
    projectId: project.id,
    provider: overrides?.provider ?? project.provider,
    reasoningEffort: overrides?.reasoningEffort ?? project.reasoningEffort,
    remoteConversationId: null,
    title: overrides?.title?.trim() || "New thread",
    updatedAt: timestamp,
  };
};

export const getConnectedProviders = (settings: AppSettings): AiProvider[] => {
  return Array.from(
    new Set(
      (Array.isArray(settings.connectedProviders)
        ? settings.connectedProviders
        : []
      ).filter((provider): provider is AiProvider =>
        ALL_PROVIDERS.includes(provider as AiProvider),
      ),
    ),
  );
};

export const getProviderAuthMode = (
  provider: AiProvider,
  settings: AppSettings,
): ProviderAuthMode => {
  if (provider === "openai") {
    return settings.openAiAuthMode;
  }

  if (provider === "anthropic") {
    return settings.anthropicAuthMode;
  }

  return "apiKey";
};

export const getProviderCredential = (
  provider: AiProvider,
  settings: AppSettings,
): string => {
  const mode = getProviderAuthMode(provider, settings);

  if (provider === "openai") {
    return mode === "apiKey" ? settings.openAiApiKey : "";
  }

  if (provider === "anthropic") {
    return mode === "apiKey" ? settings.anthropicApiKey : "claude-code";
  }

  return settings.geminiApiKey;
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
  if (!getConnectedProviders(settings).includes(provider)) {
    return [];
  }

  const clean = (models: string[]): string[] => {
    return Array.from(
      new Set(models.map((model) => model.trim()).filter(Boolean)),
    );
  };

  if (provider === "anthropic") {
    return clean(settings.anthropicSelectedModels);
  }

  if (provider === "gemini") {
    return clean(settings.geminiSelectedModels);
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
    (getConnectedProviders(settings)[0] ?? DEFAULT_PROVIDER);

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
