import type { ModelSpeed, ReasoningEffort } from "@/types/ide";
import {
  createModelOption,
  dedupeModelOptions,
  formatModelIdLabel,
  getModelReasoningEfforts,
  getModelSpeedTiers,
  isVisibleOpenAiModelOption,
  type ModelOption,
  normalizeModelSpeed,
  normalizeModelSpeedTiers,
  sortCursorModelOptions,
} from "../../electron/shared/model-options.js";

export type { ModelSpeed, ReasoningEffort };
// The model option rules are shared with the main process, which applies
// them when it fetches each provider's catalog.
export {
  createModelOption,
  dedupeModelOptions,
  formatModelIdLabel,
  getModelReasoningEfforts,
  getModelSpeedTiers,
  isVisibleOpenAiModelOption,
  type ModelOption,
  normalizeModelSpeed,
  normalizeModelSpeedTiers,
  sortCursorModelOptions,
};

/**
 * Approximate context-window sizes (in tokens) for well-known model
 * families. The lookup is intentionally generous: we match on id prefixes
 * so newly released variants are picked up automatically.
 *
 * Returns a sensible default (128 000) when the model is not recognized.
 */
const CONTEXT_WINDOW_ENTRIES: [RegExp, number][] = [
  // Anthropic
  [/^(sonnet|opus)(?:\[1m\])?$/, 1_000_000],
  [/^haiku$/, 200_000],
  [/^claude-(fable|mythos)-5(?:$|-)/, 1_000_000],
  // Opus and Sonnet 5.x and later, Opus and Sonnet 4.6 and later.
  [/^claude-(sonnet|opus)-(?:[5-9]|\d{2,})(?:$|-)/, 1_000_000],
  [/^claude-(sonnet|opus)-4-(?:[6-9]|\d{2,})/, 1_000_000],
  [/^claude-haiku-4/, 200_000],
  [/^claude-3[.-]7/, 200_000],
  [/^claude-3[.-]5/, 200_000],
  [/^claude-3/, 200_000],
  [/^claude-/, 200_000],

  // OpenAI. The GPT-5 family runs through Codex, whose catalog reports the
  // 272k input share of the 400k window as the model context window.
  [/^o[134]/, 200_000],
  [/^gpt-5\.3-codex-spark(?:$|[-.])/, 128_000],
  [/^gpt-5/, 272_000],
  [/^gpt-4o/, 128_000],
  [/^gpt-4-turbo/, 128_000],
  [/^gpt-4/, 128_000],
  [/^codex-/, 200_000],

  // xAI
  [/^grok-4(?:\.\d+)?-fast/, 2_000_000],
  [/^grok-/, 256_000],
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
