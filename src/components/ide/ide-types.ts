import type { ModelOption } from "@/lib/models";
import type {
  AiProvider,
  AppSettings,
  ReasoningEffort,
  RightPanelView,
} from "@/types/ide";

export const STATE_STORAGE_KEY = "dream:ide:state";

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
  | "plan-mode"
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
  openai: ProviderModelFetchResult;
  anthropic: ProviderModelFetchResult;
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

export const CODEX_PERMISSION_MODE_OPTIONS: Array<{
  description: string;
  label: string;
  value: CodexPermissionMode;
}> = [
  {
    description: "Ask before running actions.",
    label: "Ask",
    value: "default",
  },
  {
    description: "Edit files without asking.",
    label: "Edit",
    value: "auto-accept-edits",
  },
  {
    description: "Unsandboxed access without asking.",
    label: "Full access",
    value: "full-access",
  },
];

export const CLAUDE_PERMISSION_MODE_OPTIONS: Array<{
  description: string;
  label: string;
  value: ClaudePermissionMode;
}> = [
  {
    description: "Inspect and plan without making file edits.",
    label: "Plan mode",
    value: "plan-mode",
  },
  {
    description: "Ask before making file edits.",
    label: "Ask permissions",
    value: "ask-permissions",
  },
  {
    description: "Apply file edits without asking.",
    label: "Accept edits",
    value: "accept-edits",
  },
  {
    description: "Apply edits without approval prompts.",
    label: "Bypass permissions",
    value: "bypass-permissions",
  },
];

export const getCodexPermissionModeLabel = (
  value: CodexPermissionMode,
): string => {
  return (
    CODEX_PERMISSION_MODE_OPTIONS.find((option) => option.value === value)
      ?.label ?? "Ask"
  );
};

export const getClaudePermissionModeLabel = (
  value: ClaudePermissionMode,
): string => {
  return (
    CLAUDE_PERMISSION_MODE_OPTIONS.find((option) => option.value === value)
      ?.label ?? "Ask permissions"
  );
};

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
