import { createModelOption, type ModelOption } from "@/lib/models";
import type {
  AiProvider,
  AppSettings,
  PanelVisibility,
  PersistedIdeState,
  ProjectConfig,
  ProviderAuthMode,
  ThreadConfig,
} from "@/types/ide";

export const DEFAULT_PROVIDER: AiProvider = "openai";
const ALL_PROVIDERS: AiProvider[] = ["openai", "anthropic", "gemini"];

export const DEFAULT_SETTINGS: AppSettings = {
  anthropicAccessToken: "",
  anthropicAccessTokenExpiresAt: null,
  anthropicAuthMode: "apiKey",
  anthropicApiKey: "",
  anthropicRefreshToken: "",
  anthropicSelectedModels: [],
  connectedProviders: [],
  defaultAnthropicModel: "",
  defaultGeminiModel: "",
  defaultOpenAiModel: "",
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

export const createEmptyState = (): PersistedIdeState => ({
  activeProjectId: null,
  activeThreadIdByProject: {},
  chats: {},
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
  const connectedProviders = getConnectedProviders(settings);
  const provider = connectedProviders[0] ?? DEFAULT_PROVIDER;

  return {
    id: crypto.randomUUID(),
    model: getDefaultModelForProvider(provider, settings),
    name,
    path,
    previewUrl: "http://127.0.0.1:3000",
    provider,
    reasoningEffort: "medium",
    runCommand: "pnpm dev",
  };
};

export const createThreadConfig = (
  project: ProjectConfig,
  overrides?: Partial<
    Pick<ThreadConfig, "model" | "provider" | "reasoningEffort" | "title">
  >,
): ThreadConfig => {
  const timestamp = new Date().toISOString();

  return {
    archivedAt: null,
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
    return mode === "apiKey"
      ? settings.anthropicApiKey
      : settings.anthropicAccessToken;
  }

  return settings.geminiApiKey;
};

export const getDefaultModelForProvider = (
  provider: AiProvider,
  settings: AppSettings,
): string => {
  const openAiModels = getModelsForProvider("openai", settings);
  const anthropicModels = getModelsForProvider("anthropic", settings);
  const geminiModels = getModelsForProvider("gemini", settings);

  if (provider === "anthropic") {
    return anthropicModels.includes(settings.defaultAnthropicModel)
      ? settings.defaultAnthropicModel
      : (anthropicModels[0] ?? "");
  }

  if (provider === "gemini") {
    return geminiModels.includes(settings.defaultGeminiModel)
      ? settings.defaultGeminiModel
      : (geminiModels[0] ?? "");
  }

  return openAiModels.includes(settings.defaultOpenAiModel)
    ? settings.defaultOpenAiModel
    : (openAiModels[0] ?? "");
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
