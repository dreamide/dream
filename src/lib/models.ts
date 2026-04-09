import type { AiProvider, ReasoningEffort } from "@/types/ide";

export interface ModelOption {
  id: string;
  label: string;
  reasoningEfforts?: ReasoningEffort[];
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
    provider === "openai" ? OPENAI_TOKEN_LABELS : ANTHROPIC_TOKEN_LABELS;
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

  if (
    provider === "anthropic" &&
    ["opus", "sonnet", "haiku"].includes(parts[0]?.toLowerCase() ?? "")
  ) {
    return `Claude ${formatToken(provider, parts[0], true)}`;
  }

  return parts
    .map((part, index) => formatToken(provider, part, index === 0))
    .join(" ");
};

export const createModelOption = (
  provider: AiProvider,
  id: string,
  label?: string | null,
  reasoningEfforts: ReasoningEffort[] = [],
): ModelOption => {
  const trimmedId = id.trim();
  const trimmedLabel = label?.trim() ?? "";
  const normalizedReasoningEfforts = Array.from(
    new Set(
      reasoningEfforts.filter((effort): effort is ReasoningEffort =>
        ["low", "medium", "high", "xhigh"].includes(effort),
      ),
    ),
  );

  return {
    id: trimmedId,
    label: trimmedLabel || formatModelIdLabel(provider, trimmedId),
    ...(normalizedReasoningEfforts.length > 0
      ? { reasoningEfforts: normalizedReasoningEfforts }
      : {}),
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
    const reasoningEfforts = Array.from(
      new Set(model.reasoningEfforts ?? []),
    ).filter((effort): effort is ReasoningEffort =>
      ["low", "medium", "high", "xhigh"].includes(effort),
    );
    const existing = seen.get(id);

    if (!existing) {
      seen.set(id, {
        id,
        label,
        ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
      });
      continue;
    }

    seen.set(id, {
      id,
      label: existing.label || label,
      ...(existing.reasoningEfforts?.length || reasoningEfforts.length
        ? {
            reasoningEfforts: Array.from(
              new Set([
                ...(existing.reasoningEfforts ?? []),
                ...reasoningEfforts,
              ]),
            ),
          }
        : {}),
    });
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
/**
 * Approximate context-window sizes (in tokens) for well-known model
 * families. The lookup is intentionally generous: we match on id prefixes
 * so newly released variants are picked up automatically.
 *
 * Returns a sensible default (128 000) when the model is not recognized.
 */
const CONTEXT_WINDOW_ENTRIES: [RegExp, number][] = [
  // Anthropic
  [/^(sonnet|opus)$/, 1_000_000],
  [/^haiku$/, 200_000],
  [/^claude-(sonnet|opus)-4/, 1_000_000],
  [/^claude-haiku-4/, 200_000],
  [/^claude-3[.-]7/, 200_000],
  [/^claude-3[.-]5/, 200_000],
  [/^claude-3/, 200_000],
  [/^claude-/, 200_000],

  // OpenAI
  [/^o[134]/, 200_000],
  [/^gpt-5/, 200_000],
  [/^gpt-4o/, 128_000],
  [/^gpt-4-turbo/, 128_000],
  [/^gpt-4/, 128_000],
  [/^codex-/, 200_000],
];

const DEFAULT_CONTEXT_WINDOW = 128_000;

export const getModelContextWindow = (modelId: string): number => {
  const id = modelId.trim().toLowerCase();
  for (const [pattern, tokens] of CONTEXT_WINDOW_ENTRIES) {
    if (pattern.test(id)) return tokens;
  }
  return DEFAULT_CONTEXT_WINDOW;
};

/**
 * Very rough token estimate: ~4 characters per token on average.
 * This is not meant to be precise, just indicative for the UI gauge.
 */
export const estimateTokenCount = (text: string): number =>
  Math.ceil(text.length / 4);

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
      return ["low", "medium", "high", "xhigh"];
    }

    // Non-reasoning OpenAI models (gpt-4o, gpt-4, etc.) – no effort knob
    return [];
  }

  // --- Anthropic models with extended thinking (claude-3.7+, claude-4+) --
  if (provider === "anthropic") {
    if (["opus", "sonnet", "haiku"].includes(id)) {
      return ["low", "medium", "high", "xhigh"];
    }

    // New format: claude-{variant}-{major} e.g. claude-sonnet-4-20250514,
    // claude-opus-4-20250514
    const newFormat = id.match(/^claude-(?:sonnet|opus|haiku)-(\d+)/);
    if (newFormat) {
      const major = Number(newFormat[1]);
      if (major >= 4) {
        return ["low", "medium", "high", "xhigh"];
      }
    }

    // Old format: claude-{major}-{minor}-{variant} e.g. claude-3-7-sonnet,
    // claude-3-5-sonnet, or claude-{major}.{minor}
    const oldFormat = id.match(/^claude-(\d+)[-.](\d+)/);
    if (oldFormat) {
      const major = Number(oldFormat[1]);
      const minor = Number(oldFormat[2]);
      if (major > 3 || (major === 3 && minor >= 7)) {
        return ["low", "medium", "high", "xhigh"];
      }
    }

    // claude-4 (no minor version, no variant prefix)
    if (/^claude-(\d+)(?!\d)/.test(id)) {
      const majorOnly = Number(id.match(/^claude-(\d+)/)?.[1]);
      if (majorOnly >= 4) {
        return ["low", "medium", "high", "xhigh"];
      }
    }

    return [];
  }

  return [];
};
