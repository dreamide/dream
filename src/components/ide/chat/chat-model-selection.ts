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
import { normalizeModelSpeed, normalizeReasoningEffort } from "../ide-types";
import type { IdeState } from "../store/ide-store-types";
import type { ChatPanelModelOption } from "./chat-composer";

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
 * the chat panel (what the controls show) and the chat runtime (what is sent).
 */
export const resolveChatModelSelection = (
  chat: Pick<
    ChatConfig,
    "model" | "modelSpeed" | "provider" | "reasoningEffort"
  >,
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
