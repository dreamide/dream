import type {
  AiProvider,
  AppSettings,
  PanelVisibility,
  PersistedIdeState,
  ProjectConfig,
  ProviderAuthMode,
} from "@/types/ide";

export const DEFAULT_PROVIDER: AiProvider = "openai";
const ALL_PROVIDERS: AiProvider[] = ["openai", "anthropic"];

export const DEFAULT_SETTINGS: AppSettings = {
  anthropicApiKey: "",
  anthropicSelectedModels: [],
  connectedProviders: [],
  defaultAnthropicModel: "",
  defaultOpenAiModel: "",
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
  chats: {},
  panelVisibility: DEFAULT_PANEL_VISIBILITY,
  projects: [],
  settings: DEFAULT_SETTINGS,
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
    runCommand: "pnpm dev",
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
  return provider === "openai" ? settings.openAiAuthMode : "apiKey";
};

export const getProviderCredential = (
  provider: AiProvider,
  settings: AppSettings,
): string => {
  const mode = getProviderAuthMode(provider, settings);

  if (provider === "openai") {
    return mode === "apiKey" ? settings.openAiApiKey : "";
  }

  return settings.anthropicApiKey;
};

export const getDefaultModelForProvider = (
  provider: AiProvider,
  settings: AppSettings,
): string => {
  const openAiModels = getModelsForProvider("openai", settings);
  const anthropicModels = getModelsForProvider("anthropic", settings);

  return provider === "anthropic"
    ? anthropicModels.includes(settings.defaultAnthropicModel)
      ? settings.defaultAnthropicModel
      : (anthropicModels[0] ?? "")
    : openAiModels.includes(settings.defaultOpenAiModel)
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

  return provider === "anthropic"
    ? clean(settings.anthropicSelectedModels)
    : clean(settings.openAiSelectedModels);
};
