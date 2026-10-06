import type { ModelOption } from "@/lib/models";
import type {
  AiProvider,
  ModelSpeed,
  ReasoningEffort,
  RightPanelView,
} from "@/types/ide";
import {
  ALL_PROVIDERS,
  dedupeModels,
  normalizeModelSpeed,
  normalizeReasoningEffort,
} from "../../../electron/shared/model-selection.js";

export {
  ALL_PROVIDERS,
  dedupeModels,
  normalizeModelSpeed,
  normalizeReasoningEffort,
};

export type SettingsSection =
  | "appearance"
  | "providers"
  | "shortcuts"
  | "mcp"
  | "prompts"
  | "skills"
  | "sshHosts"
  | "chats";
export type { RightPanelView };
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
  grok?: ProviderModelFetchResult;
}

export type CliUpgradeResult =
  /** The updater ran and the CLI now reports the latest version. */
  | { status: "updated"; version: string | null }
  /** The updater exited cleanly but the CLI still reports an older version. */
  | { status: "unchanged"; version: string | null }
  | { status: "failed"; error: string };

export interface ProviderModelState {
  installed: boolean;
  models: ModelOption[];
  source: ModelFetchSource;
  loading: boolean;
  error: string | null;
  version: string | null;
}

export const REASONING_EFFORT_OPTIONS: Array<{
  value: ReasoningEffort;
}> = [
  { value: "low" },
  { value: "medium" },
  { value: "high" },
  { value: "xhigh" },
  { value: "max" },
];

export const MODEL_SPEED_OPTIONS: Array<{
  value: ModelSpeed;
}> = [{ value: "standard" }, { value: "fast" }];

export const getProviderLabel = (provider: AiProvider): string => {
  if (provider === "openai") return "OpenAI";
  if (provider === "opencode") return "OpenCode";
  if (provider === "cursor") return "Cursor";
  if (provider === "grok") return "Grok Build";
  return "Anthropic";
};
