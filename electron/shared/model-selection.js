// @ts-check
// Provider and model selection rules shared by the renderer and the main
// process. The persisted-state codec needs them to repair a stale default
// model on load; the renderer needs them everywhere a model is picked.

/** @typedef {import("../../src/types/ide").AiProvider} AiProvider */
/** @typedef {import("../../src/types/ide").AppSettings} AppSettings */
/** @typedef {import("../../src/types/ide").ModelSpeed} ModelSpeed */
/** @typedef {import("../../src/types/ide").ReasoningEffort} ReasoningEffort */

/** @type {AiProvider} */
export const DEFAULT_PROVIDER = "openai";

/** @type {AiProvider[]} */
export const ALL_PROVIDERS = [
  "openai",
  "anthropic",
  "opencode",
  "cursor",
  "grok",
];

export const CLAUDE_CODE_MODEL_IDS = /** @type {const} */ ({
  haiku: "haiku",
  opusOneMillion: "opus[1m]",
  opus: "opus",
  sonnetOneMillion: "sonnet[1m]",
  sonnet: "sonnet",
});

/** @type {ReasoningEffort[]} */
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** @type {ModelSpeed[]} */
const MODEL_SPEEDS = ["standard", "fast"];

/**
 * @param {unknown} value
 * @returns {AiProvider}
 */
export const normalizeProvider = (value) =>
  value === "anthropic" ||
  value === "opencode" ||
  value === "cursor" ||
  value === "grok"
    ? value
    : DEFAULT_PROVIDER;

/**
 * @param {unknown} value
 * @returns {ModelSpeed}
 */
export const normalizeModelSpeed = (value) =>
  MODEL_SPEEDS.includes(/** @type {ModelSpeed} */ (value))
    ? /** @type {ModelSpeed} */ (value)
    : "standard";

/**
 * "medium" is the implicit default and is represented as `null`.
 * @param {unknown} value
 * @returns {ReasoningEffort | null}
 */
export const normalizeReasoningEffort = (value) => {
  if (value === "medium") {
    return null;
  }

  return REASONING_EFFORTS.includes(/** @type {ReasoningEffort} */ (value))
    ? /** @type {ReasoningEffort} */ (value)
    : null;
};

/**
 * @param {unknown} value
 * @returns {value is ReasoningEffort}
 */
export const isReasoningEffort = (value) =>
  REASONING_EFFORTS.includes(/** @type {ReasoningEffort} */ (value));

/**
 * @param {string[]} models
 * @returns {string[]}
 */
export const dedupeModels = (models) =>
  Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));

/**
 * @param {string} modelId
 * @returns {string}
 */
export const normalizeClaudeCodeModelId = (modelId) => {
  const trimmed = modelId.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("claude-")) {
    return trimmed;
  }
  const usesOneMillionContext = /\[1m\]/i.test(trimmed);
  if (trimmed.includes("opus")) {
    return usesOneMillionContext
      ? CLAUDE_CODE_MODEL_IDS.opusOneMillion
      : CLAUDE_CODE_MODEL_IDS.opus;
  }
  if (trimmed.includes("haiku")) {
    return CLAUDE_CODE_MODEL_IDS.haiku;
  }
  if (trimmed.includes("sonnet")) {
    return usesOneMillionContext
      ? CLAUDE_CODE_MODEL_IDS.sonnetOneMillion
      : CLAUDE_CODE_MODEL_IDS.sonnet;
  }
  return trimmed;
};

/**
 * @param {AiProvider} provider
 * @param {AppSettings} settings
 * @returns {boolean}
 */
export const isProviderEnabled = (provider, settings) =>
  !settings.disabledProviders?.includes(provider);

/**
 * Models offered for a provider. A disabled provider offers none, which hides
 * it everywhere a model can be picked.
 * @param {AiProvider} provider
 * @param {AppSettings} settings
 * @returns {string[]}
 */
export const getModelsForProvider = (provider, settings) => {
  if (!isProviderEnabled(provider, settings)) {
    return [];
  }

  if (provider === "anthropic") {
    return dedupeModels(
      settings.anthropicSelectedModels.map(normalizeClaudeCodeModelId),
    );
  }

  if (provider === "opencode") {
    return dedupeModels(settings.openCodeSelectedModels);
  }

  if (provider === "cursor") {
    return dedupeModels(settings.cursorSelectedModels);
  }

  if (provider === "grok") {
    return dedupeModels(settings.grokSelectedModels);
  }

  return dedupeModels(settings.openAiSelectedModels);
};

/**
 * @param {AppSettings} settings
 * @returns {AiProvider[]}
 */
export const getConnectedProviders = (settings) =>
  ALL_PROVIDERS.filter(
    (provider) => getModelsForProvider(provider, settings).length > 0,
  );

/**
 * @param {string} modelId
 * @param {AppSettings} settings
 * @returns {AiProvider | null}
 */
export const getProviderForModel = (modelId, settings) => {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return null;
  }

  const anthropicModelId = normalizeClaudeCodeModelId(trimmed);

  for (const provider of getConnectedProviders(settings)) {
    const providerModels = getModelsForProvider(provider, settings);
    const candidate = provider === "anthropic" ? anthropicModelId : trimmed;
    if (providerModels.includes(candidate)) {
      return provider;
    }
  }

  return null;
};

/**
 * @param {string} modelId
 * @returns {string[]}
 */
const getDefaultModelCandidates = (modelId) => {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return [];
  }

  return Array.from(
    new Set([trimmed, normalizeClaudeCodeModelId(trimmed)].filter(Boolean)),
  );
};

/**
 * @param {AppSettings} settings
 * @returns {string}
 */
const getFirstAvailableModel = (settings) => {
  for (const provider of getConnectedProviders(settings)) {
    const model = getModelsForProvider(provider, settings)[0];
    if (model) {
      return model;
    }
  }

  return "";
};

/**
 * @param {AppSettings} settings
 * @param {string} [preferredModel]
 * @returns {string}
 */
export const getPreferredDefaultModel = (
  settings,
  preferredModel = settings.defaultModel,
) => {
  for (const candidate of getDefaultModelCandidates(preferredModel)) {
    if (getProviderForModel(candidate, settings)) {
      return candidate;
    }
  }

  return getFirstAvailableModel(settings);
};

/**
 * @typedef {object} ModelSelection
 * @property {string} model
 * @property {ModelSpeed} modelSpeed
 * @property {AiProvider} provider
 * @property {ReasoningEffort | null} reasoningEffort
 */

/**
 * @param {AppSettings} settings
 * @returns {ModelSelection}
 */
export const getDefaultModelSelection = (settings) => {
  const model = getPreferredDefaultModel(settings);
  const provider =
    getProviderForModel(model, settings) ??
    getConnectedProviders(settings)[0] ??
    DEFAULT_PROVIDER;

  return {
    model,
    modelSpeed: normalizeModelSpeed(settings.defaultModelSpeed),
    provider,
    reasoningEffort: isReasoningEffort(settings.defaultReasoningEffort)
      ? settings.defaultReasoningEffort
      : null,
  };
};

/**
 * @param {AppSettings} settings
 * @returns {ModelSelection}
 */
export const getDefaultGitGenerationModelSelection = (settings) => {
  const model = getPreferredDefaultModel(
    settings,
    settings.defaultGitGenerationModel || settings.defaultModel,
  );
  const provider =
    getProviderForModel(model, settings) ??
    getConnectedProviders(settings)[0] ??
    DEFAULT_PROVIDER;

  return {
    model,
    modelSpeed: normalizeModelSpeed(settings.defaultGitGenerationModelSpeed),
    provider,
    reasoningEffort: isReasoningEffort(
      settings.defaultGitGenerationReasoningEffort,
    )
      ? settings.defaultGitGenerationReasoningEffort
      : null,
  };
};

/**
 * Repairs stale default-model settings against the models actually selected.
 * @param {AppSettings} settings
 * @param {string} [preferredModel]
 * @returns {AppSettings}
 */
export const normalizeDefaultModelSettings = (
  settings,
  preferredModel = settings.defaultModel,
) => {
  const defaultModel = getPreferredDefaultModel(settings, preferredModel);
  const defaultSelection = getDefaultModelSelection({
    ...settings,
    defaultModel,
  });

  return {
    ...settings,
    defaultGitGenerationModel: getPreferredDefaultModel(
      settings,
      settings.defaultGitGenerationModel || defaultModel,
    ),
    defaultModel,
    defaultModelSpeed: defaultSelection.modelSpeed,
    defaultReasoningEffort: defaultSelection.reasoningEffort,
  };
};
