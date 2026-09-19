import { Plus, SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  PipelineRunStepId,
  PipelineStepConfig,
  PipelineTask,
} from "@/types/ide";
import { PipelineColumnModelBar } from "./pipeline-column-model-bar";
import { PipelineStepIcon } from "./pipeline-step-icon";
import type { PipelineStepDescriptor } from "./pipeline-steps";
import {
  PipelineTaskCard,
  type PipelineTaskCardProps,
} from "./pipeline-task-card";

export const PIPELINE_COLUMN_SURFACE_CLASSES = "rounded-lg text-foreground";

export interface PipelineColumnProps
  extends Omit<
    PipelineTaskCardProps,
    "backlogIndex" | "backlogSize" | "error" | "task"
  > {
  /** `null` for the backlog, which runs no agent. */
  config: PipelineStepConfig | null;
  errorsByTaskId: Record<string, string>;
  onAddTask: () => void;
  onConfigureStep: (step: PipelineRunStepId) => void;
  projectId: string;
  step: PipelineStepDescriptor;
  tasks: PipelineTask[];
}

const PipelineColumnImpl = ({
  config,
  errorsByTaskId,
  onAddTask,
  onConfigureStep,
  projectId,
  step,
  tasks,
  ...cardHandlers
}: PipelineColumnProps) => {
  const t = useTranslations("pipeline");
  const isBacklog = step.id === "backlog";

  return (
    <section
      aria-label={t(step.labelKey)}
      className={cn(
        PIPELINE_COLUMN_SURFACE_CLASSES,
        "flex min-w-72 flex-1 basis-0 flex-col",
      )}
      data-pipeline-step={step.id}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <PipelineStepIcon step={step.id} />
        <h3 className="min-w-0 truncate font-medium text-sm">
          {t(step.labelKey)}
        </h3>
        <span className="text-muted-foreground text-sm tabular-nums">
          {tasks.length}
        </span>
        {isBacklog ? (
          <Button
            aria-label={t("addTask")}
            className="ml-auto size-6 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onAddTask}
            size="icon-xs"
            title={t("addTask")}
            type="button"
            variant="ghost"
          >
            <Plus className="size-4" />
          </Button>
        ) : (
          <Button
            aria-label={t("configureStep")}
            className="ml-auto size-6 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => onConfigureStep(step.id as PipelineRunStepId)}
            size="icon-xs"
            title={t("configureStep")}
            type="button"
            variant="ghost"
          >
            <SlidersHorizontal className="size-3.5" />
          </Button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {tasks.map((task, index) => (
          <PipelineTaskCard
            {...cardHandlers}
            backlogIndex={isBacklog ? index : null}
            backlogSize={tasks.length}
            error={errorsByTaskId[task.id] ?? null}
            key={task.id}
            task={task}
          />
        ))}
        {isBacklog ? (
          <Button
            className="shrink-0 justify-start text-muted-foreground/70 hover:text-foreground"
            onClick={onAddTask}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Plus className="size-4" />
            {t("addTask")}
          </Button>
        ) : null}
      </div>
      {config && !isBacklog ? (
        <PipelineColumnModelBar
          config={config}
          projectId={projectId}
          step={step.id as PipelineRunStepId}
        />
      ) : null}
    </section>
  );
};

export const PipelineColumn = memo(PipelineColumnImpl);
PipelineColumn.displayName = "PipelineColumn";
