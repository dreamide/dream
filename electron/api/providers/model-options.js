const VALID_REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const VALID_MODEL_SPEEDS = new Set(["standard", "fast"]);

export const CLAUDE_REASONING_EFFORT_MAP = {
  high: "high",
  low: "low",
  max: "max",
  medium: "medium",
  xhigh: "high",
};

export const OPENAI_LOW_COST_MODEL_CANDIDATES = [
  "gpt-5.4-nano",
  "gpt-5.4-mini",
];
export const ANTHROPIC_LOW_COST_MODEL_CANDIDATES = ["haiku"];
const OPENAI_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
const ANTHROPIC_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const HIDDEN_OPENAI_MODEL_LABELS = new Set(["codex auto review"]);
const HIDDEN_OPENAI_MODEL_IDS = new Set(["codex-auto-review"]);

export const isVisibleOpenAiModelOption = (model) => {
  const id = model?.id?.trim().toLowerCase() ?? "";
  const label = model?.label?.trim().toLowerCase() ?? "";

  return (
    !HIDDEN_OPENAI_MODEL_IDS.has(id) && !HIDDEN_OPENAI_MODEL_LABELS.has(label)
  );
};

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

export const normalizeModelSpeed = (value) =>
  VALID_MODEL_SPEEDS.has(value) ? value : "standard";

export const normalizeModelSpeedTiers = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  const tiers = [];
  for (const entry of value) {
    const tier =
      typeof entry === "string"
        ? entry
        : typeof entry?.tier === "string"
          ? entry.tier
          : null;
    const normalized = normalizeModelSpeed(tier);
    if (normalized === "standard" || tiers.includes(normalized)) {
      continue;
    }
    tiers.push(normalized);
  }

  return tiers.length > 0 ? ["standard", ...tiers] : [];
};

const normalizeContextWindow = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;

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
    return isReasoning ? OPENAI_REASONING_EFFORTS : [];
  }

  if (provider === "anthropic") {
    if (["opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"].includes(id)) {
      return ANTHROPIC_REASONING_EFFORTS;
    }
    const newFormat = id.match(/^claude-[a-z][a-z0-9]*-(\d+)(?:$|-)/);
    if (newFormat) {
      const major = Number(newFormat[1]);
      if (major >= 4) return ANTHROPIC_REASONING_EFFORTS;
    }
    const oldFormat = id.match(/^claude-(\d+)[-.](\d+)/);
    if (oldFormat) {
      const major = Number(oldFormat[1]);
      const minor = Number(oldFormat[2]);
      if (major > 3 || (major === 3 && minor >= 7)) {
        return ANTHROPIC_REASONING_EFFORTS;
      }
    }
    if (/^claude-(\d+)(?!\d)/.test(id)) {
      const majorOnly = Number(id.match(/^claude-(\d+)/)?.[1]);
      if (majorOnly >= 4) return ANTHROPIC_REASONING_EFFORTS;
    }
    return [];
  }

  return [];
};

export const getModelSpeedTiers = (provider, modelId) => {
  if (provider !== "openai") return [];

  const id = modelId.trim().toLowerCase();
  if (/^gpt-5\.(4|5)(?:$|[-.])/.test(id)) {
    return ["standard", "fast"];
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
  fable: "Fable",
  haiku: "Haiku",
  "opus[1m]": "Opus 1M",
  opus: "Opus",
  preview: "Preview",
  "sonnet[1m]": "Sonnet 1M",
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
    ["opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku"].includes(
      parts[0]?.toLowerCase() ?? "",
    )
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
    ["haiku", "opus", "opus[1m]", "sonnet", "sonnet[1m]"].includes(normalizedId)
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
  speedTiers = [],
  contextWindow,
) => {
  const trimmedId = id.trim();
  const trimmedLabel = label?.trim() ?? "";
  const normalizedReasoningEfforts =
    normalizeReasoningEfforts(reasoningEfforts);
  const normalizedSpeedTiers = normalizeModelSpeedTiers(speedTiers);
  const normalizedContextWindow = normalizeContextWindow(contextWindow);
  return {
    id: trimmedId,
    label: getModelDisplayLabel(provider, trimmedId, trimmedLabel),
    ...(normalizedContextWindow
      ? { contextWindow: normalizedContextWindow }
      : {}),
    ...(normalizedReasoningEfforts.length > 0
      ? { reasoningEfforts: normalizedReasoningEfforts }
      : {}),
    ...(normalizedSpeedTiers.length > 0
      ? { speedTiers: normalizedSpeedTiers }
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
    const speedTiers = normalizeModelSpeedTiers(model.speedTiers);
    const contextWindow = normalizeContextWindow(model.contextWindow);
    const existing = seen.get(id);
    if (!existing) {
      seen.set(id, {
        id,
        label,
        ...(contextWindow ? { contextWindow } : {}),
        ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
        ...(speedTiers.length > 0 ? { speedTiers } : {}),
      });
      continue;
    }
    seen.set(id, {
      id,
      label: existing.label || label,
      ...(existing.contextWindow || contextWindow
        ? { contextWindow: existing.contextWindow ?? contextWindow }
        : {}),
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
      ...(existing.speedTiers?.length || speedTiers.length
        ? {
            speedTiers: Array.from(
              new Set([...(existing.speedTiers ?? []), ...speedTiers]),
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

  return "";
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
  createModelOption("anthropic", "opus", CLAUDE_CODE_MODEL_LABELS.opus),
  createModelOption("anthropic", "sonnet", CLAUDE_CODE_MODEL_LABELS.sonnet),
  createModelOption("anthropic", "haiku", CLAUDE_CODE_MODEL_LABELS.haiku),
];

export const normalizeClaudeCodeModel = (modelId) => {
  const trimmed = modelId.trim().toLowerCase();
  if (!trimmed) return "sonnet";
  const usesOneMillionContext = /\[1m\]/i.test(trimmed);
  if (trimmed.includes("opus")) {
    return usesOneMillionContext ? "opus[1m]" : "opus";
  }
  if (trimmed.includes("haiku")) return "haiku";
  if (trimmed.includes("sonnet")) {
    return usesOneMillionContext ? "sonnet[1m]" : "sonnet";
  }
  if (trimmed.startsWith("claude-")) return trimmed;
  return trimmed;
};

const MODELS_DEV_API_URL = "https://models.dev/api.json";
const CLAUDE_CODE_MODEL_ORDER = {
  "claude-fable": 0,
  "claude-opus": 1,
  "claude-sonnet": 2,
  "claude-haiku": 3,
  fable: 4,
  opus: 5,
  sonnet: 6,
  haiku: 7,
};

const isModelsDevModelRecord = (value) =>
  value !== null && typeof value === "object" && typeof value.id === "string";

const isClaudeCodeModelName = (model) =>
  /^claude-[a-z][a-z0-9]*-\d+(?:-\d{1,2})?$/.test(model.id);

const getClaudeCodeModelVersion = (model) => {
  const match = model.id.match(
    /^claude-([a-z][a-z0-9]*)-(\d+)(?:-(\d{1,2}))?$/,
  );
  if (!match) {
    return null;
  }

  return {
    family: match[1],
    major: Number(match[2]),
    minor: match[3] ? Number(match[3]) : 0,
  };
};

const isSupportedClaudeCodeModel = (model) => {
  const version = getClaudeCodeModelVersion(model);
  if (!version) {
    return false;
  }

  if (version.family === "opus") {
    return version.major > 4 || (version.major === 4 && version.minor >= 6);
  }

  if (version.family === "sonnet") {
    return version.major > 4 || (version.major === 4 && version.minor >= 5);
  }

  if (version.family === "haiku") {
    return version.major > 4 || (version.major === 4 && version.minor >= 5);
  }

  return version.major >= 5;
};

const getModelsDevAnthropicModels = (payload) => {
  const models = payload?.anthropic?.models;
  if (!models || typeof models !== "object") {
    return [];
  }

  return Object.values(models).filter(isModelsDevModelRecord);
};

const getModelsDevProviderModels = (payload, providerId) => {
  const models = payload?.[providerId]?.models;
  if (!models || typeof models !== "object") {
    return [];
  }

  return Object.values(models).filter(isModelsDevModelRecord);
};

const getModelsDevModelContextWindow = (model) =>
  normalizeContextWindow(model?.limit?.context);

const addOpenCodeContextWindow = (contextWindows, providerId, model) => {
  const contextWindow = getModelsDevModelContextWindow(model);
  if (!contextWindow) {
    return;
  }

  contextWindows.set(`${providerId}/${model.id}`, contextWindow);
  if (providerId === "opencode" && !model.id.endsWith("-free")) {
    contextWindows.set(`${providerId}/${model.id}-free`, contextWindow);
  }
};

const getClaudeCodeModelOrder = (model) =>
  CLAUDE_CODE_MODEL_ORDER[model.family] ??
  CLAUDE_CODE_MODEL_ORDER[model.id] ??
  Number.MAX_SAFE_INTEGER;

const getModelsDevReleaseDate = (model) =>
  typeof model.release_date === "string" ? model.release_date : "";

const getModelsDevLabel = (model) =>
  (typeof model.name === "string" ? model.name : model.id)
    .replace(/^Anthropic:\s*/i, "")
    .replace(/\s*\(latest\)\s*$/i, "");

const getModelsDevAliasPriority = (model) => {
  if (/-latest$/i.test(model.id)) {
    return 0;
  }

  if (!/-\d{8}$/.test(model.id)) {
    return 1;
  }

  return 2;
};

const dedupeModelsDevClaudeAliases = (models) => {
  const modelsByCanonicalId = new Map();

  for (const model of models) {
    const canonicalId = [
      model.family,
      getModelsDevLabel(model).toLowerCase(),
    ].join(":");
    const existing = modelsByCanonicalId.get(canonicalId);
    if (
      !existing ||
      getModelsDevAliasPriority(model) < getModelsDevAliasPriority(existing)
    ) {
      modelsByCanonicalId.set(canonicalId, model);
    }
  }

  return Array.from(modelsByCanonicalId.values());
};

const parseClaudeCodeModelOptionsFromModelsDev = (payload) => {
  const models = getModelsDevAnthropicModels(payload);
  if (models.length === 0) {
    return [];
  }

  return dedupeModelsDevClaudeAliases(
    models
      .filter((model) => model.status !== "deprecated")
      .filter(isClaudeCodeModelName)
      .filter(isSupportedClaudeCodeModel)
      .filter(
        (model) =>
          typeof model.family === "string" &&
          model.family.startsWith("claude-"),
      ),
  )
    .sort((a, b) => {
      const orderDelta =
        getClaudeCodeModelOrder(a) - getClaudeCodeModelOrder(b);
      if (orderDelta !== 0) {
        return orderDelta;
      }

      return getModelsDevReleaseDate(b).localeCompare(
        getModelsDevReleaseDate(a),
      );
    })
    .map((model) =>
      createModelOption("anthropic", model.id, getModelsDevLabel(model)),
    );
};

export const fetchClaudeCodeModelOptionsFromModelsDev = async () => {
  try {
    const response = await fetch(MODELS_DEV_API_URL, {
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`Models.dev request failed (${response.status}).`);
    }

    const payload = await response.json();
    const parsedModels = dedupeModelOptions(
      parseClaudeCodeModelOptionsFromModelsDev(payload),
    );
    if (parsedModels.length < 3) {
      throw new Error(
        "Models.dev did not contain the expected Anthropic model families.",
      );
    }

    return parsedModels;
  } catch {
    return CLAUDE_CODE_MODEL_OPTIONS;
  }
};

export const fetchOpenCodeContextWindowsFromModelsDev = async () => {
  try {
    const response = await fetch(MODELS_DEV_API_URL, {
      method: "GET",
    });
    if (!response.ok) {
      throw new Error(`Models.dev request failed (${response.status}).`);
    }

    const payload = await response.json();
    const contextWindows = new Map();
    for (const providerId of ["opencode", "opencode-go"]) {
      for (const model of getModelsDevProviderModels(payload, providerId)) {
        addOpenCodeContextWindow(contextWindows, providerId, model);
      }
    }

    return contextWindows;
  } catch {
    return new Map();
  }
};
