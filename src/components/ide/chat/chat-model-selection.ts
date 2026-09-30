import {
  getConnectedProviders,
  getModelOptionsForProvider,
} from "@/lib/ide-defaults";
import { getModelReasoningEfforts, getModelSpeedTiers } from "@/lib/models";
import type {
  AiProvider,
  AppSettings,
  ChatConfig,
  ModelSpeed,
  ReasoningEffort,
} from "@/types/ide";
import {
  MODEL_SPEED_OPTIONS,
  normalizeModelSpeed,
  normalizeReasoningEffort,
  REASONING_EFFORT_OPTIONS,
} from "../ide-types";
import type { IdeState } from "../store/ide-store-types";

/** A model the composer's picker offers. */
export interface ChatPanelModelOption {
  contextWindow?: number;
  id: string;
  label: string;
  provider: AiProvider;
  reasoningEfforts: ReasoningEffort[];
  speedTiers: ModelSpeed[];
}

export interface ChatModelSelection {
  allModelOptions: ChatPanelModelOption[];
  availableModelSpeedTiers: ModelSpeed[];
  availableReasoningEfforts: ReasoningEffort[];
  /** Empty when no model is enabled. */
  selectedModel: string;
  selectedModelOption: ChatPanelModelOption | undefined;
  selectedModelSpeed: ModelSpeed;
  selectedProvider: AiProvider;
  /** `null` when the model has no reasoning control. */
  selectedReasoningEffort: ReasoningEffort | null;
}

/**
 * The saved choices a model selection is resolved from. Chats and stash
 * items both carry these.
 */
export type ChatModelChoice = Pick<
  ChatConfig,
  "model" | "modelSpeed" | "provider" | "reasoningEffort"
>;

export const getChatModelOptions = (
  settings: AppSettings,
  providerModels: IdeState["providerModels"],
): ChatPanelModelOption[] =>
  getConnectedProviders(settings).flatMap((provider) =>
    getModelOptionsForProvider(
      provider,
      settings,
      providerModels[provider].models,
    ).map((model) => ({
      contextWindow: model.contextWindow,
      id: model.id,
      label: model.label,
      provider,
      reasoningEfforts: model.reasoningEfforts ?? [],
      speedTiers: model.speedTiers ?? [],
    })),
  );

/**
 * The model, speed and reasoning effort a chat actually runs with: its saved
 * choices, narrowed to what is currently connected and supported. Shared by
 * the chat panel and the stash (what the controls show) and the chat runtime
 * (what is sent).
 */
export const resolveChatModelSelection = (
  chat: ChatModelChoice,
  allModelOptions: ChatPanelModelOption[],
): ChatModelSelection => {
  const selectedModelOption =
    allModelOptions.find(
      (option) => option.provider === chat.provider && option.id === chat.model,
    ) ?? allModelOptions[0];
  const selectedProvider = selectedModelOption?.provider ?? chat.provider;
  const selectedModel = selectedModelOption?.id ?? "";

  const availableModelSpeedTiers = selectedModelOption?.speedTiers?.length
    ? selectedModelOption.speedTiers
    : getModelSpeedTiers(selectedProvider, selectedModel);
  const normalizedModelSpeed = normalizeModelSpeed(chat.modelSpeed);
  const selectedModelSpeed =
    availableModelSpeedTiers.length > 0 &&
    availableModelSpeedTiers.includes(normalizedModelSpeed)
      ? normalizedModelSpeed
      : "standard";

  const availableReasoningEfforts = selectedModelOption?.reasoningEfforts
    ?.length
    ? selectedModelOption.reasoningEfforts
    : getModelReasoningEfforts(selectedProvider, selectedModel);
  const normalizedReasoningEffort = normalizeReasoningEffort(
    chat.reasoningEffort,
  );
  const selectedReasoningEffort =
    availableReasoningEfforts.length === 0
      ? null
      : normalizedReasoningEffort &&
          availableReasoningEfforts.includes(normalizedReasoningEffort)
        ? normalizedReasoningEffort
        : availableReasoningEfforts.includes("medium")
          ? "medium"
          : availableReasoningEfforts[0];

  return {
    allModelOptions,
    availableModelSpeedTiers,
    availableReasoningEfforts,
    selectedModel,
    selectedModelOption,
    selectedModelSpeed,
    selectedProvider,
    selectedReasoningEffort,
  };
};

/** What the composer's model, effort and speed pickers show for a selection. */
export const getModelSelectionControls = (selection: ChatModelSelection) => ({
  modelLabel: selection.selectedModelOption?.label ?? selection.selectedModel,
  modelValue: selection.selectedModelOption?.id,
  /** Offered efforts, in the app's canonical order. */
  reasoningEfforts: REASONING_EFFORT_OPTIONS.map(({ value }) => value).filter(
    (value) => selection.availableReasoningEfforts.includes(value),
  ),
  /** The effort control's value; models with no control never show it. */
  reasoningEffort: selection.selectedReasoningEffort ?? "medium",
  speeds: MODEL_SPEED_OPTIONS.map(({ value }) => value).filter((value) =>
    selection.availableModelSpeedTiers.includes(value),
  ),
});

/**
 * The option a model picker's value names. Two providers can offer the same
 * model id; the chat's current provider wins the tie.
 */
export const findModelOption = (
  allModelOptions: ChatPanelModelOption[],
  id: string,
  preferredProvider: AiProvider,
) => {
  const matching = allModelOptions.filter((option) => option.id === id);
  return (
    matching.find((option) => option.provider === preferredProvider) ??
    matching[0]
  );
};
