import {
  formatModelIdLabel,
  getModelReasoningEfforts,
  getModelSpeedTiers,
  type ModelOption,
} from "@/lib/models";
import type { GraphNodeAgent } from "@/types/agent-graphs";
import type {
  AgentMode,
  AiProvider,
  ModelSpeed,
  ReasoningEffort,
} from "@/types/ide";

export type ProviderModelsLookup = Partial<
  Record<AiProvider, { models: ModelOption[] } | undefined>
>;

export interface NodeAgentDisplay {
  agentMode: AgentMode;
  /** Null when the model does not expose effort levels. */
  effort: ReasoningEffort | null;
  /** True when the model comes from the project default. */
  isDefault: boolean;
  /** Friendly model name, as shown in the chat box. */
  modelLabel: string;
  provider: AiProvider | null;
  /** Null when the model has no speed tiers. */
  speed: ModelSpeed | null;
}

/**
 * What a step will actually run with: its own settings layered over the
 * project default. Mirrors `resolveNodeAgent` in electron/api/graphs/executor.js
 * and the chat box's effort/speed fallbacks.
 */
export const describeNodeAgent = (
  nodeAgent: GraphNodeAgent,
  defaultAgent: GraphNodeAgent,
  providerModels: ProviderModelsLookup,
): NodeAgentDisplay => {
  const provider = nodeAgent.provider ?? defaultAgent.provider ?? null;
  const switchedProvider =
    Boolean(nodeAgent.provider) && nodeAgent.provider !== defaultAgent.provider;
  const model =
    nodeAgent.model || (switchedProvider ? "" : defaultAgent.model || "");
  const isDefault = !nodeAgent.provider && !nodeAgent.model;
  const agentMode = nodeAgent.agentMode === "plan" ? "plan" : "build";

  if (!provider) {
    return {
      agentMode,
      effort: null,
      isDefault,
      modelLabel: "",
      provider: null,
      speed: null,
    };
  }

  const option = model
    ? providerModels[provider]?.models.find((entry) => entry.id === model)
    : undefined;
  const modelLabel = model
    ? (option?.label ?? formatModelIdLabel(provider, model))
    : "";

  const efforts = option?.reasoningEfforts?.length
    ? option.reasoningEfforts
    : model
      ? getModelReasoningEfforts(provider, model)
      : [];
  const wantedEffort =
    nodeAgent.reasoningEffort ??
    (switchedProvider ? null : defaultAgent.reasoningEffort) ??
    null;
  const effort =
    efforts.length === 0
      ? null
      : wantedEffort && efforts.includes(wantedEffort)
        ? wantedEffort
        : efforts.includes("medium")
          ? "medium"
          : (efforts[0] ?? null);

  const speedTiers = option?.speedTiers?.length
    ? option.speedTiers
    : model
      ? getModelSpeedTiers(provider, model)
      : [];
  const wantedSpeed =
    nodeAgent.modelSpeed ??
    (switchedProvider ? undefined : defaultAgent.modelSpeed);
  const speed =
    speedTiers.length === 0
      ? null
      : wantedSpeed && speedTiers.includes(wantedSpeed)
        ? wantedSpeed
        : "standard";

  return { agentMode, effort, isDefault, modelLabel, provider, speed };
};
