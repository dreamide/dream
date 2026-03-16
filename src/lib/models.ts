import type { AiProvider, ReasoningEffort } from "@/types/ide";

export interface ModelOption {
  id: string;
  label: string;
}

const OPENAI_TOKEN_LABELS: Record<string, string> = {
  audio: "Audio",
  codex: "Codex",
  gpt: "GPT",
  mini: "Mini",
  nano: "Nano",
  omni: "Omni",
  preview: "Preview",
  realtime: "Realtime",
  search: "Search",
  transcribe: "Transcribe",
  turbo: "Turbo",
};

const ANTHROPIC_TOKEN_LABELS: Record<string, string> = {
  claude: "Claude",
  haiku: "Haiku",
  opus: "Opus",
  preview: "Preview",
  sonnet: "Sonnet",
};

const GEMINI_TOKEN_LABELS: Record<string, string> = {
  exp: "Experimental",
  flash: "Flash",
  gemini: "Gemini",
  lite: "Lite",
  preview: "Preview",
  pro: "Pro",
  thinking: "Thinking",
};

const formatToken = (
  provider: AiProvider,
  token: string,
  isFirstToken: boolean,
): string => {
  if (!token) {
    return "";
  }

  if (/^\d+(\.\d+)*$/.test(token)) {
    return token;
  }

  if (/^o\d/i.test(token)) {
    return token.toLowerCase();
  }

  const labels =
    provider === "openai"
      ? OPENAI_TOKEN_LABELS
      : provider === "anthropic"
        ? ANTHROPIC_TOKEN_LABELS
        : GEMINI_TOKEN_LABELS;
  const normalized = token.toLowerCase();
  const mapped = labels[normalized];

  if (mapped) {
    return mapped;
  }

  if (/^\d{8}$/.test(token)) {
    return token;
  }

  if (isFirstToken) {
    return token.toUpperCase();
  }

  return token.charAt(0).toUpperCase() + token.slice(1);
};

export const formatModelIdLabel = (
  provider: AiProvider,
  modelId: string,
): string => {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return "";
  }

  const parts = trimmed.split("-").filter(Boolean);
  if (parts.length === 0) {
    return trimmed;
  }

  if (provider === "openai" && parts[0]?.toLowerCase() === "gpt") {
    const [, version, ...rest] = parts;
    if (!version) {
      return "GPT";
    }
    const suffix = rest
      .map((part) => formatToken(provider, part, false))
      .join(" ");
    return suffix ? `GPT-${version} ${suffix}` : `GPT-${version}`;
  }

  if (provider === "anthropic" && parts[0]?.toLowerCase() === "claude") {
    const rest = parts
      .slice(1)
      .map((part, index) => formatToken(provider, part, index === 0))
      .join(" ");
    return rest ? `Claude ${rest}` : "Claude";
  }

  if (provider === "gemini" && parts[0]?.toLowerCase() === "gemini") {
    const rest = parts
      .slice(1)
      .map((part, index) => formatToken(provider, part, index === 0))
      .join(" ");
    return rest ? `Gemini ${rest}` : "Gemini";
  }

  return parts
    .map((part, index) => formatToken(provider, part, index === 0))
    .join(" ");
};

export const createModelOption = (
  provider: AiProvider,
  id: string,
  label?: string | null,
): ModelOption => {
  const trimmedId = id.trim();
  const trimmedLabel = label?.trim() ?? "";

  return {
    id: trimmedId,
    label: trimmedLabel || formatModelIdLabel(provider, trimmedId),
  };
};

export const dedupeModelOptions = (models: ModelOption[]): ModelOption[] => {
  const seen = new Map<string, ModelOption>();

  for (const model of models) {
    const id = model.id.trim();
    if (!id) {
      continue;
    }

    const label = model.label.trim() || id;
    if (!seen.has(id)) {
      seen.set(id, { id, label });
    }
  }

  return Array.from(seen.values());
};

/**
 * Determine which reasoning effort levels a model supports.
 *
 * Returns the list of supported `ReasoningEffort` values, or an empty array
 * if the model does not support reasoning effort at all (in which case the
 * UI selector should be disabled).
 *
 * The logic is intentionally broad: we match on known model-id patterns
 * rather than hard-coding a provider check, so new models that follow the
 * same naming conventions are picked up automatically.
 */
export const getModelReasoningEfforts = (
  provider: AiProvider,
  modelId: string,
): ReasoningEffort[] => {
  const id = modelId.trim().toLowerCase();
  if (!id) {
    return [];
  }

  // --- OpenAI reasoning models (o1, o3, o4, codex, gpt-5, …) -----------
  if (provider === "openai") {
    const isReasoning = ["gpt-5", "o1", "o3", "o4", "codex"].some(
      (prefix) =>
        id === prefix ||
        id.startsWith(`${prefix}-`) ||
        id.startsWith(`${prefix}.`),
    );

    if (isReasoning) {
      return ["low", "medium", "high"];
    }

    // Non-reasoning OpenAI models (gpt-4o, gpt-4, etc.) – no effort knob
    return [];
  }

  // --- Anthropic models with extended thinking (claude-3.7+, claude-4+) --
  if (provider === "anthropic") {
    // New format: claude-{variant}-{major} e.g. claude-sonnet-4-20250514,
    // claude-opus-4-20250514
    const newFormat = id.match(/^claude-(?:sonnet|opus|haiku)-(\d+)/);
    if (newFormat) {
      const major = Number(newFormat[1]);
      if (major >= 4) {
        return ["low", "medium", "high"];
      }
    }

    // Old format: claude-{major}-{minor}-{variant} e.g. claude-3-7-sonnet,
    // claude-3-5-sonnet, or claude-{major}.{minor}
    const oldFormat = id.match(/^claude-(\d+)[-.](\d+)/);
    if (oldFormat) {
      const major = Number(oldFormat[1]);
      const minor = Number(oldFormat[2]);
      if (major > 3 || (major === 3 && minor >= 7)) {
        return ["low", "medium", "high"];
      }
    }

    // claude-4 (no minor version, no variant prefix)
    if (/^claude-(\d+)(?!\d)/.test(id)) {
      const majorOnly = Number(id.match(/^claude-(\d+)/)?.[1]);
      if (majorOnly >= 4) {
        return ["low", "medium", "high"];
      }
    }

    return [];
  }

  // --- Gemini thinking models ------------------------------------------
  if (provider === "gemini") {
    if (id.includes("thinking")) {
      return ["low", "medium", "high"];
    }

    return [];
  }

  return [];
};
