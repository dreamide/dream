import { getConnectedProviders } from "@/lib/ide-defaults";
import type { ModelOption } from "@/lib/models";
import type {
  AiProvider,
  AppSettings,
  ChatMode,
  ReasoningEffort,
} from "@/types/ide";

export const STATE_STORAGE_KEY = "dream:ide:state";

export type SettingsSection =
  | "appearance"
  | "providers"
  | "models"
  | "terminal";

export type TerminalStatus = "running" | "stopped";
export type TerminalTransport = "pty" | "pipe";

export const PROJECT_TERMINAL_SESSION_PREFIX = "__project_terminal__:";
export const createProjectTerminalSessionId = (projectId: string): string =>
  `${PROJECT_TERMINAL_SESSION_PREFIX}${projectId}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const getPreviewTerminalSessionId = (projectId: string): string =>
  `__preview_terminal__:${projectId}`;
export const TERMINAL_MIN_HEIGHT_PX = 160;

export interface CodexLoginStatus {
  authMode: string;
  loading: boolean;
  loggedIn: boolean;
  message: string;
}

export type ModelFetchSource = "api" | "unavailable";

export interface ProviderModelFetchResult {
  models: ModelOption[];
  source: ModelFetchSource;
  error?: string;
  oauth?: {
    accessToken: string;
    expiresAt: number;
    refreshToken: string;
  };
}

export interface ProviderModelsResponse {
  fetchedAt: string;
  openai: ProviderModelFetchResult;
  anthropic: ProviderModelFetchResult;
  gemini: ProviderModelFetchResult;
}

export interface ProviderModelState {
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

export const CHAT_MODE_OPTIONS: Array<{
  label: string;
  value: ChatMode;
}> = [
  { label: "Plan", value: "plan" },
  { label: "Build", value: "build" },
];

export const normalizeChatMode = (value: unknown): ChatMode => {
  return value === "plan" || value === "build" ? value : "build";
};

export const ALL_PROVIDERS: AiProvider[] = ["openai", "anthropic", "gemini"];

export const getProviderLabel = (provider: AiProvider): string => {
  if (provider === "openai") {
    return "OpenAI";
  }

  if (provider === "anthropic") {
    return "Anthropic";
  }

  return "Gemini";
};

export const getProviderDescription = (provider: AiProvider): string => {
  if (provider === "openai") {
    return "Access GPT and Codex models for coding and general chat.";
  }

  if (provider === "anthropic") {
    return "Access Claude models for reasoning and long-context tasks.";
  }

  return "Access Google's Gemini models for chat, code, and multimodal tasks.";
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
    settings.anthropicAuthMode === "claudeProMax" ||
    settings.anthropicApiKey.trim().length > 0 ||
    settings.anthropicRefreshToken.trim().length > 0 ||
    settings.anthropicSelectedModels.length > 0;
  const hasGeminiConfig =
    settings.geminiApiKey.trim().length > 0 ||
    settings.geminiSelectedModels.length > 0;

  if (hasOpenAiConfig) {
    inferredProviders.push("openai");
  }

  if (hasAnthropicConfig) {
    inferredProviders.push("anthropic");
  }

  if (hasGeminiConfig) {
    inferredProviders.push("gemini");
  }

  return inferredProviders;
};
