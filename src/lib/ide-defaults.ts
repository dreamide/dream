import {
  createModelOption,
  type ModelOption,
  normalizeModelSpeed,
} from "@/lib/models";
import type {
  AiProvider,
  AppSettings,
  ModelSpeed,
  ProjectConfig,
  ReasoningEffort,
  SavedPrompt,
  StashItem,
} from "@/types/ide";
import {
  ALL_PROVIDERS,
  CLAUDE_CODE_MODEL_IDS,
  DEFAULT_PROVIDER,
  getConnectedProviders,
  getDefaultGitGenerationModelSelection,
  getDefaultModelSelection,
  getModelsForProvider,
  getPreferredDefaultModel,
  getProviderForModel,
  isProviderEnabled,
  isReasoningEffort,
  normalizeClaudeCodeModelId,
  normalizeDefaultModelSettings,
} from "../../electron/shared/model-selection.js";
import {
  createChatConfig,
  DEFAULT_PANEL_SIZES,
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_PROJECT_UI,
  DEFAULT_SETTINGS,
} from "../../electron/shared/persisted-state-codec.js";

// The defaults and the model-selection rules live in the shared codec so
// the main process applies the same ones when it decodes persisted state.
export {
  ALL_PROVIDERS,
  CLAUDE_CODE_MODEL_IDS,
  createChatConfig,
  DEFAULT_PANEL_SIZES,
  DEFAULT_PANEL_VISIBILITY,
  DEFAULT_PROJECT_UI,
  DEFAULT_PROVIDER,
  DEFAULT_SETTINGS,
  getConnectedProviders,
  getDefaultGitGenerationModelSelection,
  getDefaultModelSelection,
  getModelsForProvider,
  getPreferredDefaultModel,
  getProviderForModel,
  isProviderEnabled,
  normalizeClaudeCodeModelId,
  normalizeDefaultModelSettings,
};

export const createProjectConfig = (
  path: string,
  settings: AppSettings,
): ProjectConfig => {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? "project";
  const defaultSelection = getDefaultModelSelection(settings);
  const timestamp = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    icon: null,
    lastUsedAt: timestamp,
    model: defaultSelection.model,
    modelSpeed: defaultSelection.modelSpeed,
    name,
    path,
    browserUrl: "",
    provider: defaultSelection.provider,
    reasoningEffort: defaultSelection.reasoningEffort,
    runCommand: "pnpm dev",
    ui: {
      ...DEFAULT_PROJECT_UI,
      rightPanelOpen: false,
      stashItems: [],
    },
    worktree: null,
  };
};

export const createStashItem = (
  project: ProjectConfig,
  overrides?: Partial<
    Pick<
      StashItem,
      | "model"
      | "modelSpeed"
      | "permissionMode"
      | "provider"
      | "reasoningEffort"
      | "references"
      | "text"
    >
  >,
): StashItem => {
  const timestamp = new Date().toISOString();

  return {
    createdAt: timestamp,
    id: crypto.randomUUID(),
    model: overrides?.model ?? project.model,
    modelSpeed: overrides?.modelSpeed ?? project.modelSpeed,
    permissionMode: overrides?.permissionMode ?? "full-access",
    provider: overrides?.provider ?? project.provider,
    reasoningEffort:
      overrides && "reasoningEffort" in overrides
        ? (overrides.reasoningEffort ?? null)
        : project.reasoningEffort,
    references: overrides?.references ?? [],
    text: overrides?.text ?? "",
    updatedAt: timestamp,
  };
};

export const createSavedPrompt = (
  values: Pick<SavedPrompt, "name" | "prompt">,
): SavedPrompt => {
  const timestamp = new Date().toISOString();

  return {
    createdAt: timestamp,
    id: crypto.randomUUID(),
    prompt: values.prompt.trim(),
    name: values.name.trim(),
    updatedAt: timestamp,
  };
};

export const getDefaultModelForProvider = (
  provider: AiProvider,
  settings: AppSettings,
): string => {
  const providerModels = getModelsForProvider(provider, settings);
  const defaultSelection = getDefaultModelSelection(settings);

  if (
    defaultSelection.provider === provider &&
    providerModels.includes(defaultSelection.model)
  ) {
    return defaultSelection.model;
  }

  return providerModels[0] ?? "";
};

export const resolveModelSpeedForModel = (
  value: unknown,
  availableModelSpeedTiers: ModelSpeed[],
): ModelSpeed => {
  const normalized = normalizeModelSpeed(value);

  return availableModelSpeedTiers.length > 0 &&
    availableModelSpeedTiers.includes(normalized)
    ? normalized
    : "standard";
};

export const resolveReasoningEffortForModel = (
  value: unknown,
  availableReasoningEfforts: ReasoningEffort[],
): ReasoningEffort | null => {
  if (availableReasoningEfforts.length === 0) {
    return null;
  }

  const selected =
    isReasoningEffort(value) && availableReasoningEfforts.includes(value)
      ? value
      : availableReasoningEfforts.includes("medium")
        ? "medium"
        : (availableReasoningEfforts[0] ?? null);

  return selected === "medium" ? null : selected;
};

export const getModelOptionsForProvider = (
  provider: AiProvider,
  settings: AppSettings,
  availableModels: ModelOption[] = [],
): ModelOption[] => {
  const selectedIds = getModelsForProvider(provider, settings);
  const modelsById = new Map(availableModels.map((model) => [model.id, model]));
  const selectedIdSet = new Set(selectedIds);
  const orderedModels = availableModels.filter((model) =>
    selectedIdSet.has(model.id),
  );
  const orderedModelIds = new Set(orderedModels.map((model) => model.id));
  const unknownModels = selectedIds
    .filter((id) => !orderedModelIds.has(id))
    .map((id) => createModelOption(provider, id));

  return [
    ...orderedModels.map((model) => modelsById.get(model.id) ?? model),
    ...unknownModels,
  ];
};
