import { getConnectedProviders } from "@/lib/ide-defaults";
import type { AiProvider, AppSettings, ReasoningEffort } from "@/types/ide";

export const STATE_STORAGE_KEY = "dream:ide:state";

export type SettingsSection = "providers" | "models" | "terminal";

export type RunnerStatus = "running" | "stopped";

export type TerminalStatus = "running" | "stopped";
export type TerminalTransport = "pty" | "pipe";

export const GLOBAL_TERMINAL_SESSION_ID = "__global_terminal__";
export const TERMINAL_MIN_HEIGHT_PX = 160;

export interface CodexLoginStatus {
  authMode: string;
  loading: boolean;
  loggedIn: boolean;
  message: string;
}

export type ModelFetchSource = "api" | "unavailable";

export interface ProviderModelFetchResult {
  models: string[];
  source: ModelFetchSource;
  error?: string;
}

export interface ProviderModelsResponse {
  fetchedAt: string;
  openai: ProviderModelFetchResult;
  anthropic: ProviderModelFetchResult;
}

export interface ProviderModelState {
  models: string[];
  source: ModelFetchSource;
  loading: boolean;
  error: string | null;
}

export const dedupeModels = (models: string[]): string[] => {
  return Array.from(
    new Set(models.map((model) => model.trim()).filter(Boolean)),
  );
};

export const REASONING_EFFORT_OPTIONS: Array<{
  label: string;
  value: ReasoningEffort;
}> = [
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra High", value: "xhigh" },
];

export const normalizeReasoningEffort = (value: unknown): ReasoningEffort => {
  return REASONING_EFFORT_OPTIONS.some((option) => option.value === value)
    ? (value as ReasoningEffort)
    : "medium";
};

export const ALL_PROVIDERS: AiProvider[] = ["openai", "anthropic"];

export const getProviderLabel = (provider: AiProvider): string => {
  return provider === "openai" ? "OpenAI" : "Anthropic";
};

export const getProviderDescription = (provider: AiProvider): string => {
  return provider === "openai"
    ? "Access GPT and Codex models for coding and general chat."
    : "Access Claude models for reasoning and long-context tasks.";
};

export const inferConnectedProviders = (
  settings: AppSettings,
  hasExplicitConnectedProviders: boolean,
): AiProvider[] => {
  if (hasExplicitConnectedProviders) {
    return getConnectedProviders(settings);
  }

  const inferredProviders: AiProvider[] = [];
  const hasOpenAiConfig =
    settings.openAiApiKey.trim().length > 0 ||
    settings.openAiAuthMode === "codex" ||
    settings.openAiSelectedModels.length > 0;
  const hasAnthropicConfig =
    settings.anthropicApiKey.trim().length > 0 ||
    settings.anthropicSelectedModels.length > 0;

  if (hasOpenAiConfig) {
    inferredProviders.push("openai");
  }

  if (hasAnthropicConfig) {
    inferredProviders.push("anthropic");
  }

  return inferredProviders;
};
