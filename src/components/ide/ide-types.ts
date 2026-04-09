import type { ModelOption } from "@/lib/models";
import type { AiProvider, AppSettings, ReasoningEffort } from "@/types/ide";

export const STATE_STORAGE_KEY = "dream:ide:state";

export type SettingsSection = "appearance" | "providers" | "terminal";

export type TerminalStatus = "running" | "stopped";
export type TerminalTransport = "pty" | "pipe";
export type RightPanelView = "preview" | "explorer" | "changes";

export const PROJECT_TERMINAL_SESSION_PREFIX = "__project_terminal__:";
export const createProjectTerminalSessionId = (projectId: string): string =>
  `${PROJECT_TERMINAL_SESSION_PREFIX}${projectId}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const getPreviewTerminalSessionId = (projectId: string): string =>
  `__preview_terminal__:${projectId}`;
export const TERMINAL_MIN_HEIGHT_PX = 48;

export type ModelFetchSource = "cli" | "unavailable";

export interface ProviderModelFetchResult {
  installed: boolean;
  models: ModelOption[];
  source: ModelFetchSource;
  error?: string;
}

export interface ProviderModelsResponse {
  fetchedAt: string;
  openai: ProviderModelFetchResult;
  anthropic: ProviderModelFetchResult;
}

export interface ProviderModelState {
  installed: boolean;
  models: ModelOption[];
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
    ? "Uses the local Codex CLI for OpenAI models."
    : "Uses the local Claude Code CLI for Claude models.";
};

export const getEnabledProviders = (settings: AppSettings): AiProvider[] => {
  const providers: AiProvider[] = [];

  if (settings.openAiSelectedModels.length > 0) {
    providers.push("openai");
  }

  if (settings.anthropicSelectedModels.length > 0) {
    providers.push("anthropic");
  }

  return providers;
};
