import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import type {
  PipelineConfig,
  PipelineRunStepId,
  PipelineStepId,
  PipelineTask,
  PipelineTaskCompletion,
  ProjectConfig,
  ProjectWorktreeInfo,
  WorktreeCompletionAction,
} from "@/types/ide";
import {
  CompleteWorktreeDialog,
  type WorktreeCompletionResult,
} from "../../git-actions/complete-worktree-dialog";
import { useIdeStore } from "../../ide-store";
import { getCurrentPipelineRun } from "../../store/pipeline-actions";
import { PipelineColumn } from "./pipeline-column";
import { PipelineSendBackDialog } from "./pipeline-send-back-dialog";
import { PipelineSettingsDialog } from "./pipeline-settings-dialog";
import { PIPELINE_STEPS } from "./pipeline-steps";
import {
  PipelineTaskDialog,
  type PipelineTaskDialogValue,
} from "./pipeline-task-dialog";

type WorktreeProject = ProjectConfig & { worktree: ProjectWorktreeInfo };

type PipelineDialogState =
  | { mode: "create" }
  | { mode: "edit"; task: PipelineTask }
  | { mode: "sendBack"; task: PipelineTask; toStep: PipelineRunStepId }
  | { mode: "settings"; step: PipelineRunStepId }
  | { mode: "complete"; project: WorktreeProject; taskId: string };

const COMPLETION_KINDS: Record<
  WorktreeCompletionAction,
  PipelineTaskCompletion["kind"]
> = {
  merge: "merged",
  pr: "pr",
  remove: "removed",
};

export interface PipelineBoardProps {
  config: PipelineConfig;
  projectId: string;
  tasks: PipelineTask[];
}

/**
 * Tasks move down the line through actions (start, approve, send back, retry)
 * and agent outcomes — never by dragging, because a task's step reflects the
 * work that was actually done.
 */
export const PipelineBoard = ({
  config,
  projectId,
  tasks,
}: PipelineBoardProps) => {
  const t = useTranslations("pipeline");
  const addPipelineTask = useIdeStore((s) => s.addPipelineTask);
  const updatePipelineTask = useIdeStore((s) => s.updatePipelineTask);
  const deletePipelineTask = useIdeStore((s) => s.deletePipelineTask);
  const movePipelineTaskInBacklog = useIdeStore(
    (s) => s.movePipelineTaskInBacklog,
  );
  const startPipelineTask = useIdeStore((s) => s.startPipelineTask);
  const advancePipelineTask = useIdeStore((s) => s.advancePipelineTask);
  const sendPipelineTaskBack = useIdeStore((s) => s.sendPipelineTaskBack);
  const retryPipelineStep = useIdeStore((s) => s.retryPipelineStep);
  const completePipelineTask = useIdeStore((s) => s.completePipelineTask);
  const openPipelineStepChat = useIdeStore((s) => s.openPipelineStepChat);
  const reopenPipelineWorktree = useIdeStore((s) => s.reopenPipelineWorktree);
  const [dialog, setDialog] = useState<PipelineDialogState | null>(null);
  const [errorsByTaskId, setErrorsByTaskId] = useState<Record<string, string>>(
    {},
  );
  // Tasks with a step action in flight (e.g. creating the worktree).
  const [busyTaskIds, setBusyTaskIds] = useState<Record<string, true>>({});

  const tasksByStep = useMemo(() => {
    const groups: Record<PipelineStepId, PipelineTask[]> = {
      backlog: [],
      build: [],
      merge: [],
      plan: [],
      review: [],
    };
    for (const task of tasks) {
      groups[task.step].push(task);
    }
    // Finished work sinks below tasks that still need attention.
    groups.merge.sort(
      (a, b) => Number(Boolean(a.completion)) - Number(Boolean(b.completion)),
    );
    return groups;
  }, [tasks]);

  const setTaskError = useCallback((taskId: string, message: string | null) => {
    setErrorsByTaskId((current) => {
      if (message) {
        return { ...current, [taskId]: message };
      }
      if (!(taskId in current)) {
        return current;
      }
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  }, []);

  /** Runs a step action, surfacing failures (e.g. git errors) on the card. */
  const runTaskAction = useCallback(
    (taskId: string, action: () => Promise<unknown>) => {
      setTaskError(taskId, null);
      setBusyTaskIds((current) => ({ ...current, [taskId]: true }));
      action()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message.trim() : "";
          setTaskError(taskId, message || t("worktreeError"));
        })
        .finally(() => {
          setBusyTaskIds((current) => {
            const next = { ...current };
            delete next[taskId];
            return next;
          });
        });
    },
    [setTaskError, t],
  );

  const closeDialog = useCallback(() => setDialog(null), []);
  const handleAddTask = useCallback(() => setDialog({ mode: "create" }), []);
  const handleEdit = useCallback(
    (task: PipelineTask) => setDialog({ mode: "edit", task }),
    [],
  );
  const handleConfigureStep = useCallback(
    (step: PipelineRunStepId) => setDialog({ mode: "settings", step }),
    [],
  );
  const handleSendBack = useCallback(
    (task: PipelineTask, toStep: PipelineRunStepId) =>
      setDialog({ mode: "sendBack", task, toStep }),
    [],
  );
  const handleDelete = useCallback(
    (taskId: string) => {
      setTaskError(taskId, null);
      deletePipelineTask(projectId, taskId);
    },
    [deletePipelineTask, projectId, setTaskError],
  );
  const handleMoveInBacklog = useCallback(
    (taskId: string, index: number) =>
      movePipelineTaskInBacklog(projectId, taskId, index),
    [movePipelineTaskInBacklog, projectId],
  );
  const handleStart = useCallback(
    (taskId: string) =>
      runTaskAction(taskId, () => startPipelineTask(projectId, taskId)),
    [projectId, runTaskAction, startPipelineTask],
  );
  const handleAdvance = useCallback(
    (taskId: string) =>
      runTaskAction(taskId, () => advancePipelineTask(projectId, taskId)),
    [advancePipelineTask, projectId, runTaskAction],
  );
  const handleRetry = useCallback(
    (taskId: string) =>
      runTaskAction(taskId, () => retryPipelineStep(projectId, taskId)),
    [projectId, retryPipelineStep, runTaskAction],
  );
  const handleReopenWorktree = useCallback(
    (taskId: string) =>
      runTaskAction(taskId, async () => {
        if (!(await reopenPipelineWorktree(projectId, taskId))) {
          throw new Error(t("worktreeMissing"));
        }
      }),
    [projectId, reopenPipelineWorktree, runTaskAction, t],
  );
  const handleOpenChat = useCallback(
    (taskId: string, runId?: string) =>
      openPipelineStepChat(projectId, taskId, runId),
    [openPipelineStepChat, projectId],
  );

  const handleComplete = useCallback(
    (task: PipelineTask) => {
      setTaskError(task.id, null);
      const worktreeProject = task.worktreeProjectId
        ? useIdeStore
            .getState()
            .projects.find((entry) => entry.id === task.worktreeProjectId)
        : null;

      if (worktreeProject?.worktree) {
        // Merge, open a PR, or discard — then the worktree is cleaned up.
        setDialog({
          mode: "complete",
          project: worktreeProject as WorktreeProject,
          taskId: task.id,
        });
        return;
      }

      if (task.worktreeProjectId) {
        setTaskError(task.id, t("worktreeMissing"));
        return;
      }

      // Tasks that ran in place have no branch to land; just mark them done.
      completePipelineTask(projectId, task.id, {
        at: new Date().toISOString(),
        kind: "merged",
        mergeCommit: null,
        prUrl: null,
      });
    },
    [completePipelineTask, projectId, setTaskError, t],
  );

  const handleWorktreeCompleted = useCallback(
    (taskId: string, result: WorktreeCompletionResult) =>
      completePipelineTask(projectId, taskId, {
        at: new Date().toISOString(),
        kind: COMPLETION_KINDS[result.action],
        mergeCommit: result.mergeCommit,
        prUrl: result.prUrl,
      }),
    [completePipelineTask, projectId],
  );

  const handleTaskDialogSubmit = useCallback(
    (value: PipelineTaskDialogValue) => {
      if (dialog?.mode === "create") {
        addPipelineTask(projectId, value);
      } else if (dialog?.mode === "edit") {
        updatePipelineTask(projectId, dialog.task.id, value);
      }
      setDialog(null);
    },
    [addPipelineTask, dialog, projectId, updatePipelineTask],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="-m-2 min-h-0 flex-1 overflow-x-auto p-2">
        {/* Columns share the width up to 1920px; below five 18rem columns
            (plus gaps) the board scrolls instead of squeezing them. */}
        <div className="mx-auto flex h-full w-full min-w-[calc(5*18rem+4*0.5rem)] max-w-[1920px] gap-2">
          {PIPELINE_STEPS.map((step) => (
            <PipelineColumn
              busyTaskIds={busyTaskIds}
              config={step.id === "backlog" ? null : config[step.id]}
              errorsByTaskId={errorsByTaskId}
              key={step.id}
              onAddTask={handleAddTask}
              onAdvance={handleAdvance}
              onComplete={handleComplete}
              onConfigureStep={handleConfigureStep}
              onDelete={handleDelete}
              onEdit={handleEdit}
              onMoveInBacklog={handleMoveInBacklog}
              onOpenChat={handleOpenChat}
              onReopenWorktree={handleReopenWorktree}
              onRetry={handleRetry}
              onSendBack={handleSendBack}
              onStart={handleStart}
              projectId={projectId}
              step={step}
              tasks={tasksByStep[step.id]}
            />
          ))}
        </div>
      </div>
      {dialog?.mode === "create" || dialog?.mode === "edit" ? (
        <PipelineTaskDialog
          initialValue={
            dialog.mode === "edit"
              ? {
                  description: dialog.task.description,
                  title: dialog.task.title,
                }
              : null
          }
          key={dialog.mode === "edit" ? dialog.task.id : "create"}
          mode={dialog.mode}
          onClose={closeDialog}
          onSubmit={handleTaskDialogSubmit}
        />
      ) : null}
      {dialog?.mode === "sendBack" ? (
        <PipelineSendBackDialog
          findings={getCurrentPipelineRun(dialog.task)?.output ?? null}
          onClose={closeDialog}
          onSubmit={(note) => {
            const { task, toStep } = dialog;
            setDialog(null);
            runTaskAction(task.id, () =>
              sendPipelineTaskBack(projectId, task.id, toStep, note),
            );
          }}
          toStep={dialog.toStep}
        />
      ) : null}
      {dialog?.mode === "settings" ? (
        <PipelineSettingsDialog
          config={config}
          initialStep={dialog.step}
          onClose={closeDialog}
          projectId={projectId}
        />
      ) : null}
      {dialog?.mode === "complete" ? (
        <CompleteWorktreeDialog
          onCompleted={(result) =>
            handleWorktreeCompleted(dialog.taskId, result)
          }
          onOpenChange={(open) => {
            if (!open) {
              setDialog(null);
            }
          }}
          open
          project={dialog.project}
        />
      ) : null}
    </div>
  );
};
