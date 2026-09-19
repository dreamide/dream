import { Bot, MapIcon, Shield, ShieldAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useId, useMemo } from "react";
import { ProviderIcon } from "@/components/ai-elements/provider-icons";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  getConnectedProviders,
  getModelOptionsForProvider,
  resolveModelSpeedForModel,
  resolveReasoningEffortForModel,
} from "@/lib/ide-defaults";
import { getModelReasoningEfforts, getModelSpeedTiers } from "@/lib/models";
import { cn } from "@/lib/utils";
import type {
  AgentMode,
  AiProvider,
  ModelSpeed,
  PipelineRunStepId,
  PipelineStepConfig,
  ReasoningEffort,
} from "@/types/ide";
import { useIdeStore } from "../../ide-store";
import { AGENT_MODE_OPTIONS } from "../../ide-types";
import { resolvePipelineStepAgent } from "../../store/pipeline-actions";

const getAgentModeIcon = (mode: AgentMode) => (mode === "plan" ? MapIcon : Bot);

const INHERIT_MODEL = "__inherit__";
const MODEL_VALUE_SEPARATOR = "::";

// Mirrors the toolbar triggers under the chat composer.
const TRIGGER_CLASSES =
  "h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground data-[popup-open]:bg-transparent dark:bg-transparent dark:hover:bg-surface-900 dark:data-[popup-open]:bg-transparent";
const ITEM_ICON_CLASSES =
  "size-3.5 shrink-0 text-surface-500 dark:text-surface-400";

interface StepModelOption {
  id: string;
  label: string;
  provider: AiProvider;
  reasoningEfforts: ReasoningEffort[];
  speedTiers: ModelSpeed[];
  value: string;
}

// Provider-reported capabilities win; the static table only covers known ids.
const getOptionReasoningEfforts = (
  option: StepModelOption | undefined,
  provider: AiProvider,
  modelId: string,
) =>
  option?.reasoningEfforts.length
    ? option.reasoningEfforts
    : getModelReasoningEfforts(provider, modelId);

const getOptionSpeedTiers = (
  option: StepModelOption | undefined,
  provider: AiProvider,
  modelId: string,
) =>
  option?.speedTiers.length
    ? option.speedTiers
    : getModelSpeedTiers(provider, modelId);

export interface PipelineColumnModelBarProps {
  config: PipelineStepConfig;
  projectId: string;
  step: PipelineRunStepId;
}

const PipelineColumnModelBarImpl = ({
  config,
  projectId,
  step,
}: PipelineColumnModelBarProps) => {
  const t = useTranslations("pipeline");
  const chatT = useTranslations("chat");
  const modelT = useTranslations("models");
  const settingsT = useTranslations("settings");
  const settings = useIdeStore((s) => s.settings);
  const providerModels = useIdeStore((s) => s.providerModels);
  const hostProject = useIdeStore((s) =>
    s.projects.find((project) => project.id === projectId),
  );
  const setPipelineStepConfig = useIdeStore((s) => s.setPipelineStepConfig);

  const modelOptions = useMemo<StepModelOption[]>(
    () =>
      getConnectedProviders(settings).flatMap((provider) =>
        getModelOptionsForProvider(
          provider,
          settings,
          providerModels[provider].models,
        ).map((model) => ({
          id: model.id,
          label: model.label,
          provider,
          reasoningEfforts: model.reasoningEfforts ?? [],
          speedTiers: model.speedTiers ?? [],
          value: `${provider}${MODEL_VALUE_SEPARATOR}${model.id}`,
        })),
      ),
    [providerModels, settings],
  );

  const update = (
    updater: (current: PipelineStepConfig) => PipelineStepConfig,
  ) => setPipelineStepConfig(projectId, step, updater);

  // An inheriting step still shows the model it will actually run with.
  const selectedModel = config.model?.model
    ? config.model
    : hostProject
      ? resolvePipelineStepAgent(config, hostProject, settings)
      : null;
  const selectedModelValue = config.model?.model
    ? `${config.model.provider}${MODEL_VALUE_SEPARATOR}${config.model.model}`
    : INHERIT_MODEL;
  const selectedModelOption = selectedModel
    ? modelOptions.find(
        (option) =>
          option.provider === selectedModel.provider &&
          option.id === selectedModel.model,
      )
    : undefined;
  const AgentModeIcon = getAgentModeIcon(config.agentMode);
  const autoAdvanceId = useId();
  // Merge is the last step, so there is nothing to advance to.
  const canAutoAdvance = step !== "merge";
  const reasoningEfforts = selectedModel
    ? getOptionReasoningEfforts(
        selectedModelOption,
        selectedModel.provider,
        selectedModel.model,
      )
    : [];
  const speedTiers = selectedModel
    ? getOptionSpeedTiers(
        selectedModelOption,
        selectedModel.provider,
        selectedModel.model,
      )
    : [];

  const handleModelChange = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    if (value === INHERIT_MODEL) {
      update((current) => ({ ...current, model: null }));
      return;
    }

    const option = modelOptions.find((entry) => entry.value === value);
    if (!option) {
      return;
    }

    update((current) => ({
      ...current,
      model: {
        model: option.id,
        modelSpeed: resolveModelSpeedForModel(
          (current.model ?? selectedModel)?.modelSpeed,
          getOptionSpeedTiers(option, option.provider, option.id),
        ),
        provider: option.provider,
        reasoningEffort: resolveReasoningEffortForModel(
          (current.model ?? selectedModel)?.reasoningEffort,
          getOptionReasoningEfforts(option, option.provider, option.id),
        ),
      },
    }));
  };

  return (
    <footer className="relative z-10 shrink-0">
      {/* Same surface as the chat composer, without the prompt input. It sits
          flush with the column, which must not clip so the shadow shows. */}
      <div className="flex flex-col overflow-hidden rounded-lg border border-surface-300 bg-surface-50 px-2 py-1.5 shadow-md dark:border-surface-700 dark:bg-surface-900">
        <div className="flex items-center gap-1">
          <Select onValueChange={handleModelChange} value={selectedModelValue}>
            <SelectTrigger
              className={cn(TRIGGER_CLASSES, "min-w-0 shrink")}
              showChevron={false}
              title={chatT("model")}
            >
              <SelectValue placeholder={chatT("model")}>
                <span className="flex min-w-0 items-center gap-1.5">
                  {selectedModel?.model ? (
                    <ProviderIcon
                      className={ITEM_ICON_CLASSES}
                      provider={selectedModel.provider}
                    />
                  ) : null}
                  <span className="truncate">
                    {selectedModel?.model
                      ? (selectedModelOption?.label ?? selectedModel.model)
                      : t("inheritModel")}
                  </span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent
              alignItemWithTrigger={false}
              className="text-xs"
              side="top"
            >
              <SelectGroup>
                <SelectLabel>{chatT("model")}</SelectLabel>
                <SelectItem className="text-xs" value={INHERIT_MODEL}>
                  {t("inheritModel")}
                </SelectItem>
                {modelOptions.map((option) => (
                  <SelectItem
                    className="text-xs"
                    key={option.value}
                    value={option.value}
                  >
                    <span className="flex items-center gap-1.5">
                      <ProviderIcon
                        className={ITEM_ICON_CLASSES}
                        provider={option.provider}
                      />
                      <span className="truncate">{option.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>

          {canAutoAdvance ? (
            <label
              className="ml-auto flex h-7 shrink-0 items-center gap-1.5 px-2 font-medium text-muted-foreground text-xs"
              htmlFor={autoAdvanceId}
              title={t("autoAdvance")}
            >
              <Switch
                checked={config.autoAdvance}
                id={autoAdvanceId}
                onCheckedChange={(checked) =>
                  update((current) => ({ ...current, autoAdvance: checked }))
                }
                size="sm"
              />
              {t("gateAuto")}
            </label>
          ) : null}
        </div>

        <div className="flex items-center gap-1">
          <Select
            onValueChange={(value) => {
              if (value === "standard" || value === "full-access") {
                update((current) => ({ ...current, permissionMode: value }));
              }
            }}
            value={config.permissionMode}
          >
            <SelectTrigger
              className={cn(TRIGGER_CLASSES, "shrink-0")}
              showChevron={false}
              title={chatT("permissions")}
            >
              {config.permissionMode === "full-access" ? (
                <ShieldAlert className="size-3.5 shrink-0" />
              ) : (
                <Shield className="size-3.5 shrink-0" />
              )}
            </SelectTrigger>
            <SelectContent className="text-xs" side="top">
              <SelectGroup>
                <SelectLabel>{chatT("permissions")}</SelectLabel>
                <SelectItem className="text-xs" value="standard">
                  <span className="flex items-center gap-1.5">
                    <Shield className={ITEM_ICON_CLASSES} />
                    <span>{chatT("standardPermissions")}</span>
                  </span>
                </SelectItem>
                <SelectItem className="text-xs" value="full-access">
                  <span className="flex items-center gap-1.5">
                    <ShieldAlert className={ITEM_ICON_CLASSES} />
                    <span>{chatT("fullAccess")}</span>
                  </span>
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>

          <Select
            onValueChange={(value) => {
              if (value === "plan" || value === "build") {
                update((current) => ({ ...current, agentMode: value }));
              }
            }}
            value={config.agentMode}
          >
            <SelectTrigger
              className={cn(TRIGGER_CLASSES, "shrink-0")}
              showChevron={false}
              title={chatT("agentMode")}
            >
              <AgentModeIcon className="size-3.5 shrink-0" />
              <span className="truncate">{chatT(config.agentMode)}</span>
            </SelectTrigger>
            <SelectContent className="text-xs" side="top">
              <SelectGroup>
                <SelectLabel>{chatT("mode")}</SelectLabel>
                {AGENT_MODE_OPTIONS.map((option) => {
                  const OptionIcon = getAgentModeIcon(option.value);
                  return (
                    <SelectItem
                      className="text-xs"
                      key={option.value}
                      value={option.value}
                    >
                      <span className="flex items-center gap-1.5">
                        <OptionIcon className={ITEM_ICON_CLASSES} />
                        <span>{chatT(option.value)}</span>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectGroup>
            </SelectContent>
          </Select>

          {selectedModel && reasoningEfforts.length > 0 ? (
            <Select
              onValueChange={(value) => {
                if (typeof value !== "string") {
                  return;
                }
                update((current) => {
                  const base = current.model ?? selectedModel;
                  return base
                    ? {
                        ...current,
                        model: {
                          ...base,
                          reasoningEffort: resolveReasoningEffortForModel(
                            value,
                            reasoningEfforts,
                          ),
                        },
                      }
                    : current;
                });
              }}
              value={selectedModel.reasoningEffort ?? "medium"}
            >
              <SelectTrigger
                className={cn(TRIGGER_CLASSES, "shrink-0")}
                showChevron={false}
                title={settingsT("effort")}
              >
                <span className="truncate">
                  {modelT(selectedModel.reasoningEffort ?? "medium")}
                </span>
              </SelectTrigger>
              <SelectContent className="text-xs" side="top">
                <SelectGroup>
                  <SelectLabel>{settingsT("effort")}</SelectLabel>
                  {reasoningEfforts.map((effort) => (
                    <SelectItem className="text-xs" key={effort} value={effort}>
                      {modelT(effort)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}

          {selectedModel && speedTiers.length > 0 ? (
            <Select
              onValueChange={(value) => {
                if (typeof value !== "string") {
                  return;
                }
                update((current) => {
                  const base = current.model ?? selectedModel;
                  return base
                    ? {
                        ...current,
                        model: {
                          ...base,
                          modelSpeed: resolveModelSpeedForModel(
                            value,
                            speedTiers,
                          ),
                        },
                      }
                    : current;
                });
              }}
              value={selectedModel.modelSpeed}
            >
              <SelectTrigger
                className={cn(TRIGGER_CLASSES, "shrink-0")}
                showChevron={false}
                title={settingsT("speed")}
              >
                <span className="truncate">
                  {modelT(selectedModel.modelSpeed)}
                </span>
              </SelectTrigger>
              <SelectContent className="text-xs" side="top">
                <SelectGroup>
                  <SelectLabel>{settingsT("speed")}</SelectLabel>
                  {speedTiers.map((speed) => (
                    <SelectItem className="text-xs" key={speed} value={speed}>
                      {modelT(speed)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </div>
    </footer>
  );
};

export const PipelineColumnModelBar = memo(PipelineColumnModelBarImpl);
PipelineColumnModelBar.displayName = "PipelineColumnModelBar";
