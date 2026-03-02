import type {
  AiProvider,
  AppSettings,
  PanelVisibility,
  PersistedIdeState,
  ProjectConfig,
  ProviderAuthMode,
} from "@/types/ide";

export const OPEN_AI_API_KEY_MODELS = [
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-4o-mini",
];
export const OPEN_AI_CODEX_MODELS = [
  "gpt-5-codex",
  "gpt-5-codex-mini",
  "gpt-5",
  "gpt-5.1",
];
export const ANTHROPIC_MODELS = [
  "claude-3-7-sonnet-latest",
  "claude-3-5-haiku-latest",
];

export const DEFAULT_PROVIDER: AiProvider = "openai";

export const DEFAULT_SETTINGS: AppSettings = {
  anthropicApiKey: "",
  defaultAnthropicModel: ANTHROPIC_MODELS[0],
  defaultOpenAiModel: OPEN_AI_API_KEY_MODELS[0],
  openAiAuthMode: "apiKey",
  openAiApiKey: "",
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

  return {
    id: crypto.randomUUID(),
    model: getDefaultModelForProvider(DEFAULT_PROVIDER, settings),
    name,
    path,
    previewUrl: "http://127.0.0.1:3000",
    provider: DEFAULT_PROVIDER,
    runCommand: "pnpm dev",
  };
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
  const openAiModels = getOpenAiModelsForAuthMode(settings.openAiAuthMode);

  return provider === "anthropic"
    ? settings.defaultAnthropicModel
    : openAiModels.includes(settings.defaultOpenAiModel)
      ? settings.defaultOpenAiModel
      : openAiModels[0];
};

export const getOpenAiModelsForAuthMode = (
  mode: ProviderAuthMode,
): string[] => {
  return mode === "codex" ? OPEN_AI_CODEX_MODELS : OPEN_AI_API_KEY_MODELS;
};

export const getModelsForProvider = (
  provider: AiProvider,
  settings: AppSettings,
): string[] => {
  return provider === "anthropic"
    ? ANTHROPIC_MODELS
    : getOpenAiModelsForAuthMode(settings.openAiAuthMode);
};
