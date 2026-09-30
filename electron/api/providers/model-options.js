// Model option rules live in the shared module so the renderer applies the
// same ones; this file keeps the models.dev fetchers, which only the main
// process runs.
import {
  createModelOption,
  dedupeModelOptions,
  normalizeReasoningEfforts,
} from "../../shared/model-options.js";

export {
  CLAUDE_REASONING_EFFORT_MAP,
  createModelOption,
  dedupeModelOptions,
  formatModelIdLabel,
  getModelReasoningEfforts,
  getModelSpeedTiers,
  isVisibleOpenAiModelOption,
  normalizeClaudeCodeModel,
  normalizeModelSpeed,
  normalizeModelSpeedTiers,
  normalizeReasoningEfforts,
  sortCursorModelOptions,
} from "../../shared/model-options.js";

const normalizeContextWindow = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;

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
      createModelOption(
        "anthropic",
        model.id,
        getModelsDevLabel(model),
        normalizeReasoningEfforts([]),
        [],
        getModelsDevModelContextWindow(model),
      ),
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
