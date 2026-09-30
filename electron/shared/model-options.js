// @ts-check
// Model option rules shared by the renderer and the main process: which
// reasoning efforts and speed tiers a model offers, how a model id is
// labelled, and how fetched options are normalized and deduplicated.

import { normalizeModelSpeed } from "./model-selection.js";

/** @typedef {import("../../src/types/ide").AiProvider} AiProvider */
/** @typedef {import("../../src/types/ide").ModelSpeed} ModelSpeed */
/** @typedef {import("../../src/types/ide").ReasoningEffort} ReasoningEffort */

/**
 * @typedef {object} ModelOption
 * @property {string} id
 * @property {string} label
 * @property {number} [contextWindow]
 * @property {ReasoningEffort[]} [reasoningEfforts]
 * @property {ModelSpeed[]} [speedTiers]
 */

export { normalizeModelSpeed };

const VALID_REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** @type {Record<ReasoningEffort, string>} */
export const CLAUDE_REASONING_EFFORT_MAP = {
  high: "high",
  low: "low",
  max: "max",
  medium: "medium",
  xhigh: "high",
};

/** @type {ReasoningEffort[]} */
const OPENAI_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"];
/** @type {ReasoningEffort[]} */
const ANTHROPIC_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const HIDDEN_OPENAI_MODEL_LABELS = new Set(["codex auto review"]);
const HIDDEN_OPENAI_MODEL_IDS = new Set(["codex-auto-review"]);

/**
 * @param {ModelOption} model
 * @returns {boolean}
 */
export const isVisibleOpenAiModelOption = (model) => {
  const id = model?.id?.trim().toLowerCase() ?? "";
  const label = model?.label?.trim().toLowerCase() ?? "";

  return (
    !HIDDEN_OPENAI_MODEL_IDS.has(id) && !HIDDEN_OPENAI_MODEL_LABELS.has(label)
  );
};

/**
 * Accepts effort names or objects carrying one (`effort`, `value`, `id`).
 * @param {unknown} value
 * @returns {ReasoningEffort[]}
 */
export const normalizeReasoningEfforts = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  /** @type {ReasoningEffort[]} */
  const efforts = [];
  for (const entry of value) {
    const effort =
      typeof entry === "string"
        ? entry
        : typeof entry?.effort === "string"
          ? entry.effort
          : typeof entry?.value === "string"
            ? entry.value
            : typeof entry?.id === "string"
              ? entry.id
              : null;
    if (!effort || !VALID_REASONING_EFFORTS.has(effort)) {
      continue;
    }
    if (!efforts.includes(/** @type {ReasoningEffort} */ (effort))) {
      efforts.push(/** @type {ReasoningEffort} */ (effort));
    }
  }

  return efforts;
};

/**
 * Accepts tier names or objects carrying one (`tier`). Standard is implied
 * whenever any other tier exists.
 * @param {unknown} [value]
 * @returns {ModelSpeed[]}
 */
export const normalizeModelSpeedTiers = (value = []) => {
  if (!Array.isArray(value)) {
    return [];
  }

  /** @type {ModelSpeed[]} */
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

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
const normalizeContextWindow = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;

/**
 * The reasoning efforts a model offers, or none when it has no effort knob.
 * Matches known id patterns so new models with the same naming are picked
 * up automatically.
 * @param {AiProvider} provider
 * @param {string} modelId
 * @returns {ReasoningEffort[]}
 */
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
    // claude-{variant}-{major}, e.g. claude-sonnet-4, claude-fable-5
    const newFormat = id.match(/^claude-[a-z][a-z0-9]*-(\d+)(?:$|-)/);
    if (newFormat) {
      const major = Number(newFormat[1]);
      if (major >= 4) return ANTHROPIC_REASONING_EFFORTS;
    }
    // claude-{major}-{minor}-{variant}, e.g. claude-3-7-sonnet
    const oldFormat = id.match(/^claude-(\d+)[-.](\d+)/);
    if (oldFormat) {
      const major = Number(oldFormat[1]);
      const minor = Number(oldFormat[2]);
      if (major > 3 || (major === 3 && minor >= 7)) {
        return ANTHROPIC_REASONING_EFFORTS;
      }
    }
    // claude-4 (no minor version, no variant)
    if (/^claude-(\d+)(?!\d)/.test(id)) {
      const majorOnly = Number(id.match(/^claude-(\d+)/)?.[1]);
      if (majorOnly >= 4) return ANTHROPIC_REASONING_EFFORTS;
    }
    return [];
  }

  if (provider === "grok") {
    return id.startsWith("grok-") && !id.includes("composer")
      ? ["low", "medium", "high"]
      : [];
  }

  return [];
};

/**
 * @param {AiProvider} provider
 * @param {string} modelId
 * @returns {ModelSpeed[]}
 */
export const getModelSpeedTiers = (provider, modelId) => {
  if (provider !== "openai") return [];

  const id = modelId.trim().toLowerCase();
  if (/^gpt-5\.(4|5)(?:$|[-.])/.test(id)) {
    return ["standard", "fast"];
  }

  return [];
};

/** @type {Record<string, string>} */
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

/** @type {Record<string, string>} */
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

/**
 * @param {AiProvider} provider
 * @param {string} token
 * @param {boolean} isFirstToken
 * @returns {string}
 */
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

/**
 * @param {AiProvider} provider
 * @param {string} modelId
 * @returns {string}
 */
export const formatModelIdLabel = (provider, modelId) => {
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
  if (provider === "grok" && parts[0]?.toLowerCase() === "grok") {
    const rest = parts
      .slice(1)
      .map((p) => formatToken(provider, p, false))
      .join(" ");
    return rest ? `Grok ${rest}` : "Grok";
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

/**
 * @param {AiProvider} provider
 * @param {string} id
 * @param {string | null | undefined} label
 * @returns {string}
 */
const getModelDisplayLabel = (provider, id, label) => {
  const trimmedId = id.trim();
  const trimmedLabel = label?.trim() ?? "";
  const normalizedLabel = trimmedLabel.toLowerCase();
  const isGenericGrokLabel =
    provider === "grok" &&
    trimmedId.toLowerCase().startsWith("grok-") &&
    ["grok", "grok build"].includes(normalizedLabel);
  if (
    !trimmedLabel ||
    normalizedLabel === trimmedId.toLowerCase() ||
    isGenericGrokLabel
  ) {
    return formatModelIdLabel(provider, trimmedId);
  }

  return trimmedLabel;
};

/**
 * @param {string} id
 * @returns {AiProvider}
 */
const inferProviderForModelLabel = (id) => {
  const normalizedId = id.trim().toLowerCase();
  if (normalizedId.startsWith("grok-")) {
    return "grok";
  }
  if (
    normalizedId.startsWith("claude-") ||
    ["haiku", "opus", "opus[1m]", "sonnet", "sonnet[1m]"].includes(normalizedId)
  ) {
    return "anthropic";
  }

  return "openai";
};

/**
 * @param {AiProvider} provider
 * @param {string} id
 * @param {string | null} [label]
 * @param {ReasoningEffort[]} [reasoningEfforts]
 * @param {ModelSpeed[]} [speedTiers]
 * @param {number} [contextWindow]
 * @returns {ModelOption}
 */
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

/**
 * Merges options with the same id, unioning their capabilities and keeping
 * the first label.
 * @param {ModelOption[]} models
 * @returns {ModelOption[]}
 */
export const dedupeModelOptions = (models) => {
  /** @type {Map<string, ModelOption>} */
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

/**
 * @param {ModelOption} model
 * @returns {number}
 */
const getCursorModelPriority = (model) => {
  const id = model.id.trim().toLowerCase();
  const label = model.label.trim().toLowerCase();
  const searchable = `${id} ${label}`;

  if (id === "auto" || id === "cursor-auto" || label === "cursor auto") {
    return 0;
  }

  if (
    id === "composer" ||
    id === "cursor-composer" ||
    /\bcomposer\b/.test(searchable)
  ) {
    return 1;
  }

  return 2;
};

/**
 * Auto first, composer second, the rest in their original order.
 * @param {ModelOption[]} models
 * @returns {ModelOption[]}
 */
export const sortCursorModelOptions = (models) =>
  models
    .map((model, index) => ({
      index,
      model,
      priority: getCursorModelPriority(model),
    }))
    .sort(
      (left, right) =>
        left.priority - right.priority || left.index - right.index,
    )
    .map(({ model }) => model);

/**
 * The alias the Claude Code CLI is launched with. Unlike
 * `normalizeClaudeCodeModelId` (which keeps full ids for display), a full
 * id that names a family collapses to that family's alias, and an empty id
 * becomes the CLI default.
 * @param {string} modelId
 * @returns {string}
 */
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
  return trimmed;
};
