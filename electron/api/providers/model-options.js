const VALID_REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const CLAUDE_REASONING_EFFORT_MAP = {
  high: "high",
  low: "low",
  max: "max",
  medium: "medium",
  xhigh: "high",
};

export const OPENAI_LOW_COST_MODEL_CANDIDATES = [
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1-mini",
  "gpt-4o-mini",
];
export const ANTHROPIC_LOW_COST_MODEL_CANDIDATES = ["haiku"];

export const normalizeReasoningEfforts = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const efforts = [];
  for (const entry of value) {
    const effort =
      typeof entry === "string"
        ? entry
        : typeof entry?.effort === "string"
          ? entry.effort
          : null;
    if (!effort || !VALID_REASONING_EFFORTS.has(effort)) {
      continue;
    }
    if (!efforts.includes(effort)) {
      efforts.push(effort);
    }
  }

  return efforts;
};

export const getModelReasoningEfforts = (provider, modelId) => {
  const id = modelId.trim().toLowerCase();
  if (!id) return [];

  if (provider === "openai") {
    const isReasoning = ["gpt-5", "o1", "o3", "o4", "codex"].some(
      (prefix) =>
        id === prefix ||
        id.startsWith(`${prefix}-`) ||
        id.startsWith(`${prefix}.`),
    );
    return isReasoning ? ["low", "medium", "high", "xhigh"] : [];
  }

  if (provider === "anthropic") {
    if (["opus", "sonnet", "haiku"].includes(id)) {
      return ["low", "medium", "high", "max"];
    }
    const newFormat = id.match(/^claude-(?:sonnet|opus|haiku)-(\d+)/);
    if (newFormat) {
      const major = Number(newFormat[1]);
      if (major >= 4) return ["low", "medium", "high", "max"];
    }
    const oldFormat = id.match(/^claude-(\d+)[-.](\d+)/);
    if (oldFormat) {
      const major = Number(oldFormat[1]);
      const minor = Number(oldFormat[2]);
      if (major > 3 || (major === 3 && minor >= 7)) {
        return ["low", "medium", "high", "max"];
      }
    }
    if (/^claude-(\d+)(?!\d)/.test(id)) {
      const majorOnly = Number(id.match(/^claude-(\d+)/)?.[1]);
      if (majorOnly >= 4) return ["low", "medium", "high", "max"];
    }
    return [];
  }

  return [];
};

const OPENAI_TOKEN_LABELS = {
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

const ANTHROPIC_TOKEN_LABELS = {
  claude: "Claude",
  haiku: "Haiku",
  opus: "Opus",
  preview: "Preview",
  sonnet: "Sonnet",
};

const formatToken = (provider, token, isFirstToken) => {
  if (!token) return "";
  if (/^\d+(\.\d+)*$/.test(token)) return token;
  if (/^o\d/i.test(token)) return token.toLowerCase();
  const labels =
    provider === "openai" ? OPENAI_TOKEN_LABELS : ANTHROPIC_TOKEN_LABELS;
  const normalized = token.toLowerCase();
  const mapped = labels[normalized];
  if (mapped) return mapped;
  if (/^\d{8}$/.test(token)) return token;
  if (isFirstToken) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
};

const formatModelIdLabel = (provider, modelId) => {
  const trimmed = modelId.trim();
  if (!trimmed) return "";
  const parts = trimmed.split("-").filter(Boolean);
  if (parts.length === 0) return trimmed;
  if (provider === "openai" && parts[0]?.toLowerCase() === "gpt") {
    const [, version, ...rest] = parts;
    if (!version) return "GPT";
    const suffix = rest.map((p) => formatToken(provider, p, false)).join(" ");
    return suffix ? `GPT-${version} ${suffix}` : `GPT-${version}`;
  }
  if (provider === "anthropic" && parts[0]?.toLowerCase() === "claude") {
    const rest = parts
      .slice(1)
      .map((p, i) => formatToken(provider, p, i === 0))
      .join(" ");
    return rest ? `Claude ${rest}` : "Claude";
  }
  if (
    provider === "anthropic" &&
    ["opus", "sonnet", "haiku"].includes(parts[0]?.toLowerCase() ?? "")
  ) {
    return `Claude ${formatToken(provider, parts[0], true)}`;
  }
  return parts.map((p, i) => formatToken(provider, p, i === 0)).join(" ");
};

const getModelDisplayLabel = (provider, id, label) => {
  const trimmedId = id.trim();
  const trimmedLabel = label?.trim() ?? "";
  if (!trimmedLabel || trimmedLabel.toLowerCase() === trimmedId.toLowerCase()) {
    return formatModelIdLabel(provider, trimmedId);
  }

  return trimmedLabel;
};

const inferProviderForModelLabel = (id) => {
  const normalizedId = id.trim().toLowerCase();
  if (
    normalizedId.startsWith("claude-") ||
    ["haiku", "opus", "sonnet"].includes(normalizedId)
  ) {
    return "anthropic";
  }

  return "openai";
};

export const createModelOption = (
  provider,
  id,
  label,
  reasoningEfforts = [],
) => {
  const trimmedId = id.trim();
  const trimmedLabel = label?.trim() ?? "";
  const normalizedReasoningEfforts =
    normalizeReasoningEfforts(reasoningEfforts);
  return {
    id: trimmedId,
    label: getModelDisplayLabel(provider, trimmedId, trimmedLabel),
    ...(normalizedReasoningEfforts.length > 0
      ? { reasoningEfforts: normalizedReasoningEfforts }
      : {}),
  };
};

export const dedupeModelOptions = (models) => {
  const seen = new Map();
  for (const model of models) {
    const id = model.id.trim();
    if (!id) continue;
    const label = getModelDisplayLabel(
      inferProviderForModelLabel(id),
      id,
      model.label,
    );
    const reasoningEfforts = normalizeReasoningEfforts(model.reasoningEfforts);
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

export const selectLowCostOpenAiModel = (models) => {
  const modelIds = models.map((model) => model?.id?.trim()).filter(Boolean);
  const modelIdsByLowercase = new Map(
    modelIds.map((id) => [id.toLowerCase(), id]),
  );

  for (const candidate of OPENAI_LOW_COST_MODEL_CANDIDATES) {
    const matched = modelIdsByLowercase.get(candidate.toLowerCase());
    if (matched) {
      return matched;
    }
  }

  return (
    modelIds.find((id) => /\bmini\b/i.test(id.replace(/[-_.]/g, " "))) ??
    modelIds.find((id) => /\bnano\b/i.test(id.replace(/[-_.]/g, " "))) ??
    ""
  );
};

export const selectLowCostAnthropicModel = (models) => {
  const modelIds = models.map((model) => model?.id?.trim()).filter(Boolean);
  const modelIdsByLowercase = new Map(
    modelIds.map((id) => [id.toLowerCase(), id]),
  );

  for (const candidate of ANTHROPIC_LOW_COST_MODEL_CANDIDATES) {
    const matched = modelIdsByLowercase.get(candidate.toLowerCase());
    if (matched) {
      return matched;
    }
  }

  return (
    modelIds.find((id) => /\bhaiku\b/i.test(id.replace(/[-_.]/g, " "))) ?? ""
  );
};

const CLAUDE_CODE_MODEL_LABELS = {
  haiku: "Claude Haiku",
  opus: "Claude Opus",
  sonnet: "Claude Sonnet",
};

const CLAUDE_CODE_MODEL_OPTIONS = [
  createModelOption("anthropic", "sonnet", CLAUDE_CODE_MODEL_LABELS.sonnet),
  createModelOption("anthropic", "opus", CLAUDE_CODE_MODEL_LABELS.opus),
  createModelOption("anthropic", "haiku", CLAUDE_CODE_MODEL_LABELS.haiku),
];

export const normalizeClaudeCodeModel = (modelId) => {
  const trimmed = modelId.trim().toLowerCase();
  if (!trimmed) return "sonnet";
  if (trimmed.includes("opus")) return "opus";
  if (trimmed.includes("haiku")) return "haiku";
  if (trimmed.includes("sonnet")) return "sonnet";
  return trimmed;
};

const CLAUDE_MODELS_OVERVIEW_URL =
  "https://platform.claude.com/docs/en/about-claude/models/overview";
const CLAUDE_CODE_MODELS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let claudeCodeModelOptionsCache = {
  expiresAt: 0,
  models: CLAUDE_CODE_MODEL_OPTIONS,
};
const CLAUDE_CODE_MODEL_ORDER = { sonnet: 0, opus: 1, haiku: 2 };

const decodeHtmlEntities = (value) => {
  return value
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
};

const stripHtml = (value) => {
  return decodeHtmlEntities(
    value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
  );
};

const parseClaudeCodeModelOptionsFromDocs = (html) => {
  const headerMatches = Array.from(
    html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi),
    (match) => stripHtml(match[1]).trim(),
  ).filter(Boolean);
  const modelHeaders = headerMatches.filter((header) =>
    /^Claude (Opus|Sonnet|Haiku)\b/i.test(header),
  );

  if (modelHeaders.length < 3) {
    return [];
  }

  return modelHeaders.flatMap((header) => {
    const variant = header.match(/^Claude (Opus|Sonnet|Haiku)\b/i)?.[1];
    if (!variant) return [];
    return [createModelOption("anthropic", variant.toLowerCase(), header)];
  });
};

export const fetchClaudeCodeModelOptionsFromDocs = async () => {
  if (Date.now() < claudeCodeModelOptionsCache.expiresAt) {
    return claudeCodeModelOptionsCache.models;
  }

  try {
    const response = await fetch(CLAUDE_MODELS_OVERVIEW_URL, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Anthropic docs request failed (${response.status}).`);
    }

    const html = await response.text();
    const parsedModels = dedupeModelOptions(
      parseClaudeCodeModelOptionsFromDocs(html),
    ).sort((a, b) => {
      const aOrder = CLAUDE_CODE_MODEL_ORDER[a.id] ?? Number.MAX_SAFE_INTEGER;
      const bOrder = CLAUDE_CODE_MODEL_ORDER[b.id] ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    });
    if (parsedModels.length < 3) {
      throw new Error(
        "Anthropic docs page did not contain Claude Code models.",
      );
    }

    claudeCodeModelOptionsCache = {
      expiresAt: Date.now() + CLAUDE_CODE_MODELS_CACHE_TTL_MS,
      models: parsedModels,
    };
    return parsedModels;
  } catch {
    return CLAUDE_CODE_MODEL_OPTIONS;
  }
};
