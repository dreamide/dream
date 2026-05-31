import {
  normalizeClaudeCodeModelId,
  normalizeDefaultModelSettings,
} from "@/lib/ide-defaults";
import { dedupeModelOptions, isVisibleOpenAiModelOption } from "@/lib/models";
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
  cursor: {
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
  opencode: {
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
    return normalizeDefaultModelSettings(nextSettings);
  }

  if (provider === "opencode") {
    const current = dedupeModels(settings.openCodeSelectedModels);
    const openCodeSelectedModels = current.includes(model)
      ? current.filter((value) => value !== model)
      : [...current, model];
    const nextSettings = {
      ...settings,
      openCodeSelectedModels,
    };
    return normalizeDefaultModelSettings(nextSettings);
  }

  if (provider === "cursor") {
    const current = dedupeModels(settings.cursorSelectedModels);
    const cursorSelectedModels = current.includes(model)
      ? current.filter((value) => value !== model)
      : [...current, model];
    const nextSettings = {
      ...settings,
      cursorSelectedModels,
    };
    return normalizeDefaultModelSettings(nextSettings);
  }

  const current = dedupeModels(settings.anthropicSelectedModels);
  const anthropicSelectedModels = current.includes(model)
    ? current.filter((value) => value !== model)
    : [...current, model];
  const nextSettings = {
    ...settings,
    anthropicSelectedModels,
  };
  return normalizeDefaultModelSettings(nextSettings);
};

export const markProviderModelsLoading = (
  providerModels: IdeState["providerModels"],
  provider?: AiProvider,
): IdeState["providerModels"] => ({
  ...providerModels,
  anthropic: {
    ...providerModels.anthropic,
    error:
      provider === undefined || provider === "anthropic"
        ? null
        : providerModels.anthropic.error,
    loading:
      provider === undefined
        ? true
        : provider === "anthropic"
          ? true
          : providerModels.anthropic.loading,
  },
  openai: {
    ...providerModels.openai,
    error:
      provider === undefined || provider === "openai"
        ? null
        : providerModels.openai.error,
    loading:
      provider === undefined
        ? true
        : provider === "openai"
          ? true
          : providerModels.openai.loading,
  },
  opencode: {
    ...providerModels.opencode,
    error:
      provider === undefined || provider === "opencode"
        ? null
        : providerModels.opencode.error,
    loading:
      provider === undefined
        ? true
        : provider === "opencode"
          ? true
          : providerModels.opencode.loading,
  },
  cursor: {
    ...providerModels.cursor,
    error:
      provider === undefined || provider === "cursor"
        ? null
        : providerModels.cursor.error,
    loading:
      provider === undefined
        ? true
        : provider === "cursor"
          ? true
          : providerModels.cursor.loading,
  },
});

export const getProviderModelsFromResponse = (
  payload: ProviderModelsResponse,
  previous: IdeState["providerModels"] = DEFAULT_PROVIDER_MODELS,
): IdeState["providerModels"] => {
  const anthropic = payload.anthropic
    ? {
        error: payload.anthropic.error ?? null,
        installed: payload.anthropic.installed,
        loading: false,
        models: dedupeModelOptions(payload.anthropic.models),
        source: payload.anthropic.source,
        version: payload.anthropic.version ?? null,
      }
    : previous.anthropic;
  const openai = payload.openai
    ? {
        error: payload.openai.error ?? null,
        installed: payload.openai.installed,
        loading: false,
        models: dedupeModelOptions(payload.openai.models).filter(
          isVisibleOpenAiModelOption,
        ),
        source: payload.openai.source,
        version: payload.openai.version ?? null,
      }
    : previous.openai;
  const opencode = payload.opencode
    ? {
        error: payload.opencode.error ?? null,
        installed: payload.opencode.installed,
        loading: false,
        models: dedupeModelOptions(payload.opencode.models),
        source: payload.opencode.source,
        version: payload.opencode.version ?? null,
      }
    : previous.opencode;
  const cursor = payload.cursor
    ? {
        error: payload.cursor.error ?? null,
        installed: payload.cursor.installed,
        loading: false,
        models: dedupeModelOptions(payload.cursor.models),
        source: payload.cursor.source,
        version: payload.cursor.version ?? null,
      }
    : previous.cursor;

  return {
    anthropic,
    cursor,
    fetchedAt: payload.fetchedAt ?? new Date().toISOString(),
    openai,
    opencode,
  };
};

const shouldReconcileProviderSelection = (
  providerModels: IdeState["providerModels"][AiProvider],
): boolean => {
  return (
    providerModels.source === "cli" &&
    providerModels.error === null &&
    providerModels.models.length > 0
  );
};

const reconcileProviderSelection = (
  selectedModels: string[],
  availableModelIds: string[],
  providerModels: IdeState["providerModels"][AiProvider],
): string[] => {
  const selected = dedupeModels(selectedModels);

  if (!shouldReconcileProviderSelection(providerModels)) {
    return selected;
  }

  return selected.filter((model) => availableModelIds.includes(model));
};

export const reconcileSettingsWithProviderModels = (
  settings: AppSettings,
  providerModels: IdeState["providerModels"],
): AppSettings => {
  const openAiModelIds = providerModels.openai.models.map((model) => model.id);
  const anthropicModelIds = providerModels.anthropic.models.map(
    (model) => model.id,
  );
  const openCodeModelIds = providerModels.opencode.models.map(
    (model) => model.id,
  );
  const cursorModelIds = providerModels.cursor.models.map((model) => model.id);
  const openAiSelectedModels = reconcileProviderSelection(
    settings.openAiSelectedModels,
    openAiModelIds,
    providerModels.openai,
  );
  const anthropicSelectedModels = reconcileProviderSelection(
    settings.anthropicSelectedModels.map(normalizeClaudeCodeModelId),
    anthropicModelIds,
    providerModels.anthropic,
  );
  const openCodeSelectedModels = reconcileProviderSelection(
    settings.openCodeSelectedModels,
    openCodeModelIds,
    providerModels.opencode,
  );
  const cursorSelectedModels = reconcileProviderSelection(
    settings.cursorSelectedModels,
    cursorModelIds,
    providerModels.cursor,
  );
  const nextSettings = {
    ...settings,
    anthropicSelectedModels,
    cursorSelectedModels,
    openCodeSelectedModels,
    openAiSelectedModels,
  };

  return normalizeDefaultModelSettings(nextSettings);
};

export const areSettingsSelectionsEqual = (a: AppSettings, b: AppSettings) =>
  a.defaultModel === b.defaultModel &&
  a.defaultModelSpeed === b.defaultModelSpeed &&
  a.defaultReasoningEffort === b.defaultReasoningEffort &&
  a.openAiSelectedModels.length === b.openAiSelectedModels.length &&
  a.anthropicSelectedModels.length === b.anthropicSelectedModels.length &&
  a.openCodeSelectedModels.length === b.openCodeSelectedModels.length &&
  a.cursorSelectedModels.length === b.cursorSelectedModels.length &&
  a.openAiSelectedModels.every(
    (model, index) => b.openAiSelectedModels[index] === model,
  ) &&
  a.anthropicSelectedModels.every(
    (model, index) => b.anthropicSelectedModels[index] === model,
  ) &&
  a.openCodeSelectedModels.every(
    (model, index) => b.openCodeSelectedModels[index] === model,
  ) &&
  a.cursorSelectedModels.every(
    (model, index) => b.cursorSelectedModels[index] === model,
  );

export const getProviderModelsErrorState = (
  providerModels: IdeState["providerModels"],
  message: string,
  provider?: AiProvider,
): IdeState["providerModels"] => ({
  anthropic: {
    ...providerModels.anthropic,
    error:
      provider && provider !== "anthropic"
        ? providerModels.anthropic.error
        : message,
    loading:
      provider && provider !== "anthropic"
        ? providerModels.anthropic.loading
        : false,
  },
  fetchedAt: providerModels.fetchedAt,
  openai: {
    ...providerModels.openai,
    error:
      provider && provider !== "openai" ? providerModels.openai.error : message,
    loading:
      provider && provider !== "openai" ? providerModels.openai.loading : false,
  },
  opencode: {
    ...providerModels.opencode,
    error:
      provider && provider !== "opencode"
        ? providerModels.opencode.error
        : message,
    loading:
      provider && provider !== "opencode"
        ? providerModels.opencode.loading
        : false,
  },
  cursor: {
    ...providerModels.cursor,
    error:
      provider && provider !== "cursor" ? providerModels.cursor.error : message,
    loading:
      provider && provider !== "cursor" ? providerModels.cursor.loading : false,
  },
});
