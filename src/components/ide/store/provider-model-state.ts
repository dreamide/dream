import {
  getPreferredDefaultModel,
  normalizeClaudeCodeModelId,
} from "@/lib/ide-defaults";
import { dedupeModelOptions } from "@/lib/models";
import type { AiProvider, AppSettings } from "@/types/ide";
import { dedupeModels, type ProviderModelsResponse } from "../ide-types";
import type { IdeState } from "./ide-store-types";

export const DEFAULT_PROVIDER_MODELS: IdeState["providerModels"] = {
  anthropic: {
    error: null,
    installed: false,
    loading: false,
    models: [],
    source: "unavailable",
    version: null,
  },
  fetchedAt: null,
  openai: {
    error: null,
    installed: false,
    loading: false,
    models: [],
    source: "unavailable",
    version: null,
  },
};

export const toggleProviderModelInSettings = (
  settings: AppSettings,
  provider: AiProvider,
  model: string,
): AppSettings => {
  if (provider === "openai") {
    const current = dedupeModels(settings.openAiSelectedModels);
    const openAiSelectedModels = current.includes(model)
      ? current.filter((value) => value !== model)
      : [...current, model];
    const nextSettings = {
      ...settings,
      openAiSelectedModels,
    };
    return {
      ...nextSettings,
      defaultModel: getPreferredDefaultModel(nextSettings),
    };
  }

  const current = dedupeModels(settings.anthropicSelectedModels);
  const anthropicSelectedModels = current.includes(model)
    ? current.filter((value) => value !== model)
    : [...current, model];
  const nextSettings = {
    ...settings,
    anthropicSelectedModels,
  };
  return {
    ...nextSettings,
    defaultModel: getPreferredDefaultModel(nextSettings),
  };
};

export const markProviderModelsLoading = (
  providerModels: IdeState["providerModels"],
): IdeState["providerModels"] => ({
  ...providerModels,
  anthropic: {
    ...providerModels.anthropic,
    error: null,
    loading: true,
  },
  openai: {
    ...providerModels.openai,
    error: null,
    loading: true,
  },
});

export const getProviderModelsFromResponse = (
  payload: ProviderModelsResponse,
): IdeState["providerModels"] => ({
  anthropic: {
    error: payload.anthropic.error ?? null,
    installed: payload.anthropic.installed,
    loading: false,
    models: dedupeModelOptions(payload.anthropic.models),
    source: payload.anthropic.source,
    version: payload.anthropic.version ?? null,
  },
  fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
  openai: {
    error: payload.openai.error ?? null,
    installed: payload.openai.installed,
    loading: false,
    models: dedupeModelOptions(payload.openai.models),
    source: payload.openai.source,
    version: payload.openai.version ?? null,
  },
});

export const reconcileSettingsWithProviderModels = (
  settings: AppSettings,
  providerModels: IdeState["providerModels"],
): AppSettings => {
  const openAiModelIds = providerModels.openai.models.map((model) => model.id);
  const anthropicModelIds = providerModels.anthropic.models.map(
    (model) => model.id,
  );
  const openAiSelectedModels = dedupeModels(
    settings.openAiSelectedModels,
  ).filter((model) => openAiModelIds.includes(model));
  const anthropicSelectedModels = dedupeModels(
    settings.anthropicSelectedModels.map(normalizeClaudeCodeModelId),
  ).filter((model) => anthropicModelIds.includes(model));
  const nextSettings = {
    ...settings,
    anthropicSelectedModels,
    openAiSelectedModels,
  };

  return {
    ...nextSettings,
    defaultModel: getPreferredDefaultModel(nextSettings),
  };
};

export const areSettingsSelectionsEqual = (a: AppSettings, b: AppSettings) =>
  a.defaultModel === b.defaultModel &&
  a.openAiSelectedModels.length === b.openAiSelectedModels.length &&
  a.anthropicSelectedModels.length === b.anthropicSelectedModels.length &&
  a.openAiSelectedModels.every(
    (model, index) => b.openAiSelectedModels[index] === model,
  ) &&
  a.anthropicSelectedModels.every(
    (model, index) => b.anthropicSelectedModels[index] === model,
  );

export const getProviderModelsErrorState = (
  providerModels: IdeState["providerModels"],
  message: string,
): IdeState["providerModels"] => ({
  anthropic: {
    ...providerModels.anthropic,
    error: message,
    loading: false,
  },
  fetchedAt: providerModels.fetchedAt,
  openai: {
    ...providerModels.openai,
    error: message,
    loading: false,
  },
});
