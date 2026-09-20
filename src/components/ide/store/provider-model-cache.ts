import type { ModelOption } from "@/lib/models";
import type { AiProvider } from "@/types/ide";
import type { ProviderModelState } from "../ide-types";
import type { IdeState } from "./ide-store-types";
import { DEFAULT_PROVIDER_MODELS } from "./provider-model-state";

type ProviderModels = IdeState["providerModels"];

const STORAGE_KEY = "dream-provider-models-v1";
const PROVIDERS = [
  "anthropic",
  "cursor",
  "grok",
  "openai",
  "opencode",
] as const satisfies readonly AiProvider[];

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const readModelOption = (value: unknown): ModelOption | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.label !== "string") {
    return null;
  }

  return {
    id: raw.id,
    label: raw.label,
    ...(typeof raw.contextWindow === "number" &&
    Number.isFinite(raw.contextWindow)
      ? { contextWindow: raw.contextWindow }
      : {}),
    ...(isStringArray(raw.reasoningEfforts)
      ? {
          reasoningEfforts:
            raw.reasoningEfforts as ModelOption["reasoningEfforts"],
        }
      : {}),
    ...(isStringArray(raw.speedTiers)
      ? { speedTiers: raw.speedTiers as ModelOption["speedTiers"] }
      : {}),
  };
};

const readProviderState = (
  value: unknown,
  fallback: ProviderModelState,
): ProviderModelState => {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.models)) {
    return fallback;
  }

  return {
    ...fallback,
    installed: raw.installed === true,
    models: raw.models.flatMap((entry) => {
      const model = readModelOption(entry);
      return model ? [model] : [];
    }),
    source:
      typeof raw.source === "string"
        ? (raw.source as ProviderModelState["source"])
        : fallback.source,
    version: typeof raw.version === "string" ? raw.version : null,
  };
};

/**
 * The last successfully fetched model lists, so model pickers know each
 * model's capabilities (efforts, speed tiers) before the first fetch of a
 * session returns. `fetchedAt` stays `null` so startup still refreshes them.
 */
export const readCachedProviderModels = (): ProviderModels => {
  try {
    if (typeof localStorage === "undefined") {
      return DEFAULT_PROVIDER_MODELS;
    }

    const saved: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    );
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      return DEFAULT_PROVIDER_MODELS;
    }

    const raw = saved as Record<string, unknown>;
    const next: ProviderModels = { ...DEFAULT_PROVIDER_MODELS };
    for (const provider of PROVIDERS) {
      next[provider] = readProviderState(
        raw[provider],
        DEFAULT_PROVIDER_MODELS[provider],
      );
    }
    return next;
  } catch {
    return DEFAULT_PROVIDER_MODELS;
  }
};

/** Transient fields (loading, errors) are never cached. */
export const writeCachedProviderModels = (
  providerModels: ProviderModels,
): void => {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }

    const snapshot = Object.fromEntries(
      PROVIDERS.map((provider) => {
        const { installed, models, source, version } = providerModels[provider];
        return [provider, { installed, models, source, version }];
      }),
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // The model lists still work for this session without the cache.
  }
};
