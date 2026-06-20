import type { ModelOption } from "@/lib/models";
import type {
  AgentMode,
  AiProvider,
  AppSettings,
  ModelSpeed,
  ReasoningEffort,
  RightPanelView,
} from "@/types/ide";

export type SettingsSection = "appearance" | "providers" | "chats";

export type TerminalStatus = "running" | "stopped";
export type TerminalTransport = "pty" | "pipe";
export type { RightPanelView };
export type CodexPermissionMode =
  | "default"
  | "auto-accept-edits"
  | "full-access";
export type ClaudePermissionMode =
  | "ask-permissions"
  | "accept-edits"
  | "bypass-permissions";

export const PROJECT_TERMINAL_SESSION_PREFIX = "__project_terminal__:";
export const createProjectTerminalSessionId = (projectId: string): string =>
  `${PROJECT_TERMINAL_SESSION_PREFIX}${projectId}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
export const getBrowserTerminalSessionId = (projectId: string): string =>
  `__browser_terminal__:${projectId}`;
export const TERMINAL_MIN_HEIGHT_PX = 48;

export type ModelFetchSource = "cli" | "unavailable";

export interface ProviderModelFetchResult {
  installed: boolean;
  models: ModelOption[];
  source: ModelFetchSource;
  error?: string;
  version?: string | null;
}

export interface ProviderModelsResponse {
  fetchedAt: string;
  openai?: ProviderModelFetchResult;
  anthropic?: ProviderModelFetchResult;
  opencode?: ProviderModelFetchResult;
  cursor?: ProviderModelFetchResult;
}

export interface ProviderModelState {
  installed: boolean;
  models: ModelOption[];
  source: ModelFetchSource;
  loading: boolean;
  error: string | null;
  version: string | null;
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
  { label: "Max", value: "max" },
];

export const MODEL_SPEED_OPTIONS: Array<{
  description: string;
  label: string;
  value: ModelSpeed;
}> = [
  {
    description: "Default speed, normal usage.",
    label: "Standard",
    value: "standard",
  },
  {
    description: "1.5x speed, increased usage.",
    label: "Fast",
    value: "fast",
  },
];

export const AGENT_MODE_OPTIONS: Array<{
  description: string;
  label: string;
  value: AgentMode;
}> = [
  {
    description: "Ask before making changes.",
    label: "Plan",
    value: "plan",
  },
  {
    description: "Apply edits without asking.",
    label: "Build",
    value: "build",
  },
];

export const getPermissionModesForAgentMode = (
  value: AgentMode,
): {
  claudePermissionMode: ClaudePermissionMode;
  codexPermissionMode: CodexPermissionMode;
} => {
  if (value === "plan") {
    return {
      claudePermissionMode: "ask-permissions",
      codexPermissionMode: "default",
    };
  }

  return {
    claudePermissionMode: "accept-edits",
    codexPermissionMode: "auto-accept-edits",
  };
};

export const normalizeReasoningEffort = (
  value: unknown,
): ReasoningEffort | null => {
  if (value === "medium") {
    return null;
  }

  return REASONING_EFFORT_OPTIONS.some((option) => option.value === value)
    ? (value as ReasoningEffort)
    : null;
};

export const normalizeModelSpeed = (value: unknown): ModelSpeed => {
  return MODEL_SPEED_OPTIONS.some((option) => option.value === value)
    ? (value as ModelSpeed)
    : "standard";
};

export const ALL_PROVIDERS: AiProvider[] = [
  "openai",
  "anthropic",
  "opencode",
  "cursor",
];

export const getProviderLabel = (provider: AiProvider): string => {
  if (provider === "openai") return "OpenAI";
  if (provider === "opencode") return "OpenCode";
  if (provider === "cursor") return "Cursor";
  return "Anthropic";
};

export const getProviderDescription = (provider: AiProvider): string => {
  if (provider === "openai") {
    return "Uses the local Codex CLI for OpenAI models.";
  }
  if (provider === "opencode") {
    return "Uses the local OpenCode CLI and its configured providers.";
  }
  if (provider === "cursor") {
    return "Uses the local Cursor Agent CLI.";
  }
  return "Uses the local Claude Code CLI for Claude models.";
};

export const getEnabledProviders = (settings: AppSettings): AiProvider[] => {
  const providers: AiProvider[] = [];

  if (settings.openAiSelectedModels.length > 0) {
    providers.push("openai");
  }

  if (settings.anthropicSelectedModels.length > 0) {
    providers.push("anthropic");
  }

  if (settings.openCodeSelectedModels.length > 0) {
    providers.push("opencode");
  }

  if (settings.cursorSelectedModels.length > 0) {
    providers.push("cursor");
  }

  return providers;
};
