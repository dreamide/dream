import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_PIPELINE_PROMPTS,
  PIPELINE_PROMPT_VARIABLES,
  PIPELINE_RUN_STEP_IDS,
} from "@/lib/pipeline-defaults";
import type {
  PipelineConfig,
  PipelineRunStepId,
  PipelineStepConfig,
} from "@/types/ide";
import { useIdeStore } from "../../ide-store";
import { PipelineStepIcon } from "./pipeline-step-icon";
import { PIPELINE_STEP_LABEL_KEYS } from "./pipeline-steps";

export interface PipelineSettingsDialogProps {
  config: PipelineConfig;
  initialStep: PipelineRunStepId;
  onClose: () => void;
  projectId: string;
}

export const PipelineSettingsDialog = ({
  config,
  initialStep,
  onClose,
  projectId,
}: PipelineSettingsDialogProps) => {
  const t = useTranslations("pipeline");
  const commonT = useTranslations("common");
  const setPipelineStepConfig = useIdeStore((s) => s.setPipelineStepConfig);
  const resetPipelineStepConfig = useIdeStore((s) => s.resetPipelineStepConfig);
  const [step, setStep] = useState<PipelineRunStepId>(initialStep);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const stepConfig = config[step];
  const promptValue = stepConfig.prompt ?? DEFAULT_PIPELINE_PROMPTS[step];
  const isDefaultPrompt = stepConfig.prompt === null;

  const update = (
    updater: (current: PipelineStepConfig) => PipelineStepConfig,
  ) => setPipelineStepConfig(projectId, step, updater);

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
