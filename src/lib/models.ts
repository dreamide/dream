import type { AiProvider } from "@/types/ide";

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
