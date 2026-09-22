import { Plus, SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useId, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { TaskEntry, TaskRunStepId, TaskStepConfig } from "@/types/ide";
import { useIdeStore } from "../../ide-store";
import { TaskCard, type TaskCardProps } from "./task-card";
import { TaskColumnModelBar } from "./task-column-model-bar";
import { TaskStepIcon } from "./task-step-icon";
import type { TaskStepDescriptor } from "./task-steps";

export const TASK_COLUMN_SURFACE_CLASSES =
  "rounded-lg bg-surface-100/60 text-foreground dark:bg-surface-800/30";

export interface TaskColumnProps
  extends Omit<
    TaskCardProps,
    "backlogIndex" | "backlogSize" | "busy" | "entry" | "error" | "selected"
  > {
  busyKeys: Record<string, true>;
  /** The step's app-wide settings; `null` for the backlog, which runs no agent. */
  config: TaskStepConfig | null;
  entries: TaskEntry[];
  errorsByKey: Record<string, string>;
  onAddTask: () => void;
  onConfigureStep: (step: TaskRunStepId) => void;
  /** The project the board is filtered to, if any; previews inherited models. */
  hostProjectId: string | null;
  /** The task shown in the chat pane, if any. */
  selectedTaskId: string | null;
  step: TaskStepDescriptor;
}

const TaskColumnImpl = ({
  busyKeys,
  config,
  entries,
  errorsByKey,
  onAddTask,
  onConfigureStep,
  hostProjectId,
  selectedTaskId,
  step,
  ...cardProps
}: TaskColumnProps) => {
  const t = useTranslations("tasks");
  const isBacklog = step.id === "backlog";
  const autoAdvanceId = useId();
  const setTaskStepConfig = useIdeStore((s) => s.setTaskStepConfig);

  // Backlog order is per project: "move up" must swap with the previous task
  // of the same project even when other projects' tasks sit in between.
  const backlogPositions = useMemo(() => {
    const sizes = new Map<string, number>();
    const indexes = entries.map((entry) => {
      const index = sizes.get(entry.projectId) ?? 0;
      sizes.set(entry.projectId, index + 1);
      return index;
    });
    return { indexes, sizes };
  }, [entries]);

  return (
    <section
      aria-label={t(step.labelKey)}
      className={cn(
        TASK_COLUMN_SURFACE_CLASSES,
        "flex min-w-72 flex-1 basis-0 flex-col",
      )}
      data-task-step={step.id}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <TaskStepIcon step={step.id} />
        <h3 className="min-w-0 truncate font-medium text-sm">
          {t(step.labelKey)}
        </h3>
        <span className="text-muted-foreground text-sm tabular-nums">
          {entries.length}
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
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {config && step.id !== "merge" ? (
              <label
                className="flex h-7 shrink-0 items-center gap-1.5 font-medium text-muted-foreground text-xs"
                htmlFor={autoAdvanceId}
                title={t("autoAdvance")}
              >
                <Switch
                  checked={config.autoAdvance}
                  id={autoAdvanceId}
                  onCheckedChange={(checked) =>
                    setTaskStepConfig(step.id as TaskRunStepId, (current) => ({
                      ...current,
                      autoAdvance: checked,
                    }))
                  }
                  size="sm"
                />
                {t("gateAuto")}
              </label>
            ) : null}
            <Button
              aria-label={t("configureStep")}
              className="ml-auto size-6 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => onConfigureStep(step.id as TaskRunStepId)}
              size="icon-xs"
              title={t("configureStep")}
              type="button"
              variant="ghost"
            >
              <SlidersHorizontal className="size-3.5" />
            </Button>
          </div>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {entries.map((entry, index) => (
          <TaskCard
            {...cardProps}
            selected={entry.task.id === selectedTaskId}
            backlogIndex={
              isBacklog ? (backlogPositions.indexes[index] ?? null) : null
            }
            backlogSize={backlogPositions.sizes.get(entry.projectId) ?? 0}
            busy={Boolean(busyKeys[entry.key])}
            entry={entry}
            error={errorsByKey[entry.key] ?? null}
            key={entry.key}
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
        <TaskColumnModelBar
          config={config}
          hostProjectId={hostProjectId}
          step={step.id as TaskRunStepId}
        />
      ) : null}
    </section>
  );
};

export const TaskColumn = memo(TaskColumnImpl);
TaskColumn.displayName = "TaskColumn";
