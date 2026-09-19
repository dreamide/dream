import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";
import { ProviderIcon } from "@/components/ai-elements/provider-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  getConnectedProviders,
  getModelOptionsForProvider,
  resolveModelSpeedForModel,
  resolveReasoningEffortForModel,
} from "@/lib/ide-defaults";
import { getModelReasoningEfforts, getModelSpeedTiers } from "@/lib/models";
import {
  DEFAULT_PIPELINE_PROMPTS,
  PIPELINE_PROMPT_VARIABLES,
  PIPELINE_RUN_STEP_IDS,
} from "@/lib/pipeline-defaults";
import type {
  AgentMode,
  AiProvider,
  ChatPermissionMode,
  PipelineConfig,
  PipelineRunStepId,
  PipelineStepConfig,
} from "@/types/ide";
import { useIdeStore } from "../../ide-store";
import { AGENT_MODE_OPTIONS } from "../../ide-types";
import { PipelineStepIcon } from "./pipeline-step-icon";
import { PIPELINE_STEP_LABEL_KEYS } from "./pipeline-steps";

const INHERIT_MODEL = "__inherit__";
const DEFAULT_EFFORT = "__default__";
const MODEL_VALUE_SEPARATOR = "::";

export interface PipelineSettingsDialogProps {
  config: PipelineConfig;
  initialStep: PipelineRunStepId;
  onClose: () => void;
  projectId: string;
}

interface StepModelOption {
  id: string;
  label: string;
  provider: AiProvider;
  value: string;
}

export const PipelineSettingsDialog = ({
  config,
  initialStep,
  onClose,
  projectId,
}: PipelineSettingsDialogProps) => {
  const t = useTranslations("pipeline");
  const chatT = useTranslations("chat");
  const modelT = useTranslations("models");
  const commonT = useTranslations("common");
  const settings = useIdeStore((s) => s.settings);
  const providerModels = useIdeStore((s) => s.providerModels);
  const setPipelineStepConfig = useIdeStore((s) => s.setPipelineStepConfig);
  const resetPipelineStepConfig = useIdeStore((s) => s.resetPipelineStepConfig);
  const [step, setStep] = useState<PipelineRunStepId>(initialStep);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const stepConfig = config[step];
  const promptValue = stepConfig.prompt ?? DEFAULT_PIPELINE_PROMPTS[step];
  const isDefaultPrompt = stepConfig.prompt === null;

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
          value: `${provider}${MODEL_VALUE_SEPARATOR}${model.id}`,
        })),
      ),
    [providerModels, settings],
  );

  const update = (
    updater: (current: PipelineStepConfig) => PipelineStepConfig,
  ) => setPipelineStepConfig(projectId, step, updater);

  const selectedModel = stepConfig.model;
  const selectedModelValue = selectedModel
    ? `${selectedModel.provider}${MODEL_VALUE_SEPARATOR}${selectedModel.model}`
    : INHERIT_MODEL;
  const selectedModelOption = modelOptions.find(
    (option) => option.value === selectedModelValue,
  );
  const reasoningEfforts = selectedModel
    ? getModelReasoningEfforts(selectedModel.provider, selectedModel.model)
    : [];
  const speedTiers = selectedModel
    ? getModelSpeedTiers(selectedModel.provider, selectedModel.model)
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
          current.model?.modelSpeed,
          getModelSpeedTiers(option.provider, option.id),
        ),
        provider: option.provider,
        reasoningEffort: resolveReasoningEffortForModel(
          current.model?.reasoningEffort,
          getModelReasoningEfforts(option.provider, option.id),
        ),
      },
    }));
  };

  const insertVariable = (variable: string) => {
    const token = `{{${variable}}}`;
    const textarea = promptRef.current;
    const start = textarea?.selectionStart ?? promptValue.length;
    const end = textarea?.selectionEnd ?? promptValue.length;
    const next = `${promptValue.slice(0, start)}${token}${promptValue.slice(end)}`;
    update((current) => ({ ...current, prompt: next }));
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base leading-6">
            {t("stepSettingsTitle")}
          </DialogTitle>
          <DialogDescription>{t("stepSettingsDescription")}</DialogDescription>
        </DialogHeader>

        <Tabs
          onValueChange={(value) => setStep(value as PipelineRunStepId)}
          value={step}
        >
          <TabsList>
            {PIPELINE_RUN_STEP_IDS.map((id) => (
              <TabsTrigger className="gap-1.5" key={id} value={id}>
                <PipelineStepIcon step={id} />
                {t(PIPELINE_STEP_LABEL_KEYS[id])}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{chatT("model")}</Label>
            <Select
              onValueChange={handleModelChange}
              value={selectedModelValue}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {selectedModel ? (
                    <span className="flex min-w-0 items-center gap-1.5">
                      <ProviderIcon
                        className="size-3.5 shrink-0"
                        provider={selectedModel.provider}
                      />
                      <span className="truncate">
                        {selectedModelOption?.label ?? selectedModel.model}
                      </span>
                    </span>
                  ) : (
                    t("inheritModel")
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={INHERIT_MODEL}>
                    {t("inheritModel")}
                  </SelectItem>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <span className="flex items-center gap-1.5">
                        <ProviderIcon
                          className="size-3.5 shrink-0"
                          provider={option.provider}
                        />
                        <span className="truncate">{option.label}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{modelT("reasoning")}</Label>
              <Select
                disabled={reasoningEfforts.length === 0}
                onValueChange={(value) => {
                  if (typeof value !== "string" || !selectedModel) {
                    return;
                  }
                  update((current) =>
                    current.model
                      ? {
                          ...current,
                          model: {
                            ...current.model,
                            reasoningEffort: resolveReasoningEffortForModel(
                              value === DEFAULT_EFFORT ? "medium" : value,
                              reasoningEfforts,
                            ),
                          },
                        }
                      : current,
                  );
                }}
                value={selectedModel?.reasoningEffort ?? DEFAULT_EFFORT}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {reasoningEfforts.length === 0
                      ? "—"
                      : modelT(selectedModel?.reasoningEffort ?? "medium")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {reasoningEfforts.map((effort) => (
                      <SelectItem
                        key={effort}
                        value={effort === "medium" ? DEFAULT_EFFORT : effort}
                      >
                        {modelT(effort)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("speedLabel")}</Label>
              <Select
                disabled={speedTiers.length < 2}
                onValueChange={(value) => {
                  if (typeof value !== "string") {
                    return;
                  }
                  update((current) =>
                    current.model
                      ? {
                          ...current,
                          model: {
                            ...current.model,
                            modelSpeed: resolveModelSpeedForModel(
                              value,
                              speedTiers,
                            ),
                          },
                        }
                      : current,
                  );
                }}
                value={selectedModel?.modelSpeed ?? "standard"}
              >
                <SelectTrigger className="w-full">
                  <SelectValue>
                    {modelT(selectedModel?.modelSpeed ?? "standard")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {speedTiers.map((speed) => (
                      <SelectItem key={speed} value={speed}>
                        {modelT(speed)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{chatT("agentMode")}</Label>
            <Select
              onValueChange={(value) => {
                if (value === "plan" || value === "build") {
                  update((current) => ({
                    ...current,
                    agentMode: value as AgentMode,
                  }));
                }
              }}
              value={stepConfig.agentMode}
            >
              <SelectTrigger className="w-full">
                <SelectValue>{chatT(stepConfig.agentMode)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {AGENT_MODE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {chatT(option.value)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{chatT("permissions")}</Label>
            <Select
              onValueChange={(value) => {
                if (value === "standard" || value === "full-access") {
                  update((current) => ({
                    ...current,
                    permissionMode: value as ChatPermissionMode,
                  }));
                }
              }}
              value={stepConfig.permissionMode}
            >
              <SelectTrigger className="w-full">
                <SelectValue>
                  {stepConfig.permissionMode === "standard"
                    ? chatT("standardPermissions")
                    : chatT("fullAccess")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="standard">
                    {chatT("standardPermissions")}
                  </SelectItem>
                  <SelectItem value="full-access">
                    {chatT("fullAccess")}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>

        {stepConfig.permissionMode === "standard" ||
        stepConfig.agentMode === "plan" ? (
          <p className="text-muted-foreground text-xs leading-5">
            {t("permissionHint")}
          </p>
        ) : null}

        <div className="flex items-start justify-between gap-4 rounded-md border border-surface-300 p-3 dark:border-surface-700">
          <div className="space-y-1">
            <Label htmlFor="pipeline-auto-advance">{t("autoAdvance")}</Label>
            <p className="text-muted-foreground text-xs leading-5">
              {step === "merge"
                ? t("autoAdvanceMergeHint")
                : t("autoAdvanceHint")}
            </p>
          </div>
          <Switch
            checked={step === "merge" ? false : stepConfig.autoAdvance}
            disabled={step === "merge"}
            id="pipeline-auto-advance"
            onCheckedChange={(checked) =>
              update((current) => ({ ...current, autoAdvance: checked }))
            }
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="pipeline-step-prompt">{t("promptLabel")}</Label>
            <Button
              className="h-6 px-2 text-xs"
              disabled={isDefaultPrompt}
              onClick={() =>
                update((current) => ({ ...current, prompt: null }))
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("resetPrompt")}
            </Button>
          </div>
          <Textarea
            className="max-h-72 min-h-40 font-mono text-xs leading-5"
            id="pipeline-step-prompt"
            onChange={(event) => {
              const value = event.target.value;
              update((current) => ({
                ...current,
                // Storing `null` keeps the step on future default prompts.
                prompt: value === DEFAULT_PIPELINE_PROMPTS[step] ? null : value,
              }));
            }}
            ref={promptRef}
            rows={10}
            value={promptValue}
          />
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-muted-foreground text-xs">
              {t("promptVariables")}
            </span>
            {PIPELINE_PROMPT_VARIABLES.map((variable) => (
              <button
                className="rounded-sm bg-surface-200/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground dark:bg-surface-700/60"
                key={variable}
                onClick={() => insertVariable(variable)}
                type="button"
              >
                {`{{${variable}}}`}
              </button>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={() => resetPipelineStepConfig(projectId, step)}
            type="button"
            variant="outline"
          >
            {t("resetStep")}
          </Button>
          <Button onClick={onClose} type="button">
            {commonT("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
