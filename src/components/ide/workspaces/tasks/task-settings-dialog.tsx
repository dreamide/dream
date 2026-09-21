import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  DEFAULT_TASK_PROMPTS,
  TASK_PROMPT_VARIABLES,
  TASK_RUN_STEP_IDS,
} from "@/lib/task-defaults";
import type { TaskConfig, TaskRunStepId, TaskStepConfig } from "@/types/ide";
import { useIdeStore } from "../../ide-store";
import { TaskStepIcon } from "./task-step-icon";
import { TASK_STEP_LABEL_KEYS } from "./task-steps";

export interface TaskSettingsDialogProps {
  config: TaskConfig;
  initialStep: TaskRunStepId;
  onClose: () => void;
}

export const TaskSettingsDialog = ({
  config,
  initialStep,
  onClose,
}: TaskSettingsDialogProps) => {
  const t = useTranslations("tasks");
  const commonT = useTranslations("common");
  const setTaskStepConfig = useIdeStore((s) => s.setTaskStepConfig);
  const [step, setStep] = useState<TaskRunStepId>(initialStep);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const stepConfig = config[step];
  const promptValue = stepConfig.prompt ?? DEFAULT_TASK_PROMPTS[step];
  const isDefaultPrompt = stepConfig.prompt === null;

  const update = (updater: (current: TaskStepConfig) => TaskStepConfig) =>
    setTaskStepConfig(step, updater);

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
        </DialogHeader>

        <Tabs
          onValueChange={(value) => setStep(value as TaskRunStepId)}
          value={step}
        >
          <TabsList>
            {TASK_RUN_STEP_IDS.map((id) => (
              <TabsTrigger className="gap-1.5" key={id} value={id}>
                <TaskStepIcon step={id} />
                {t(TASK_STEP_LABEL_KEYS[id])}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="task-step-prompt">{t("promptLabel")}</Label>
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
            className="max-h-[60vh] min-h-80 text-sm leading-5"
            id="task-step-prompt"
            onChange={(event) => {
              const value = event.target.value;
              update((current) => ({
                ...current,
                // Storing `null` keeps the step on future default prompts.
                prompt: value === DEFAULT_TASK_PROMPTS[step] ? null : value,
              }));
            }}
            ref={promptRef}
            rows={16}
            value={promptValue}
          />
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-muted-foreground text-xs">
              {t("promptVariables")}
            </span>
            {TASK_PROMPT_VARIABLES.map((variable) => (
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
          <Button onClick={onClose} type="button">
            {commonT("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
