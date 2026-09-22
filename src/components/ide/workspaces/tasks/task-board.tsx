import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import type {
  ProjectConfig,
  ProjectWorktreeInfo,
  TaskCompletion,
  TaskEntry,
  TaskRunStepId,
  TaskStepId,
  WorktreeCompletionAction,
} from "@/types/ide";
import {
  CompleteWorktreeDialog,
  type WorktreeCompletionResult,
} from "../../git-actions/complete-worktree-dialog";
import { useIdeStore } from "../../ide-store";
import { getCurrentTaskRun } from "../../store/task-actions";
import { TaskColumn } from "./task-column";
import {
  TaskDialog,
  type TaskDialogValue,
  type TaskProjectOption,
} from "./task-dialog";
import { TaskSendBackDialog } from "./task-send-back-dialog";
import { TaskSettingsDialog } from "./task-settings-dialog";
import { TASK_STEPS } from "./task-steps";

type WorktreeProject = ProjectConfig & { worktree: ProjectWorktreeInfo };

type TaskDialogState =
  | { mode: "create" }
  | { mode: "edit"; entry: TaskEntry }
  | { mode: "sendBack"; entry: TaskEntry; toStep: TaskRunStepId }
  | { mode: "settings"; step: TaskRunStepId }
  | {
      mode: "complete";
      /** Discarding uses the plain worktree dialog; shipping the task one. */
      discard: boolean;
      entry: TaskEntry;
      project: WorktreeProject;
    };

const COMPLETION_KINDS: Record<
  WorktreeCompletionAction,
  TaskCompletion["kind"]
> = {
  merge: "merged",
  pr: "pr",
  remove: "removed",
};

export interface TaskBoardProps {
  /** Tasks in view, each tagged with the project that owns it. */
  entries: TaskEntry[];
  /** Open projects a new task can be filed under. */
  projects: ProjectConfig[];
  /** Closed projects it can also go to; filing a task does not open them. */
  recentProjects: ProjectConfig[];
  /**
   * The project the board is filtered to, or `null` when it spans all of them.
   * Step settings are app-wide, so they are the same either way.
   */
  scopeProject: ProjectConfig | null;
}

/**
 * Tasks move down the line through actions (start, approve, send back, retry)
 * and agent outcomes — never by dragging, because a task's step reflects the
 * work that was actually done.
 *
 * Every action is routed through the entry's own `projectId`, so the same
 * board serves one project or all of them.
 */
export const TaskBoard = ({
  entries,
  projects,
  recentProjects,
  scopeProject,
}: TaskBoardProps) => {
  const t = useTranslations("tasks");
  const addTask = useIdeStore((s) => s.addTask);
  const addTaskToProjectPath = useIdeStore((s) => s.addTaskToProjectPath);
  const updateTask = useIdeStore((s) => s.updateTask);
  const deleteTask = useIdeStore((s) => s.deleteTask);
  const moveTaskInBacklog = useIdeStore((s) => s.moveTaskInBacklog);
  const startTask = useIdeStore((s) => s.startTask);
  const advanceTask = useIdeStore((s) => s.advanceTask);
  const sendTaskBack = useIdeStore((s) => s.sendTaskBack);
  const retryTaskStep = useIdeStore((s) => s.retryTaskStep);
  const completeTask = useIdeStore((s) => s.completeTask);
  const openTaskPane = useIdeStore((s) => s.openTaskPane);
  const selectedTaskId = useIdeStore((s) => s.tasksPane?.taskId ?? null);
  const reopenTaskWorktree = useIdeStore((s) => s.reopenTaskWorktree);
  const recreateTaskWorktree = useIdeStore((s) => s.recreateTaskWorktree);
  const taskConfig = useIdeStore((s) => s.taskConfig);
  const [dialog, setDialog] = useState<TaskDialogState | null>(null);
  // Keyed by `entry.key`, the task id.
  const [errorsByKey, setErrorsByKey] = useState<Record<string, string>>({});
  // Tasks with a step action in flight (e.g. creating the worktree).
  const [busyKeys, setBusyKeys] = useState<Record<string, true>>({});

  const entriesByStep = useMemo(() => {
    const groups: Record<TaskStepId, TaskEntry[]> = {
      backlog: [],
      build: [],
      merge: [],
      plan: [],
      review: [],
    };
    for (const entry of entries) {
      groups[entry.task.step].push(entry);
    }
    // Finished work sinks below tasks that still need attention.
    groups.merge.sort(
      (a, b) =>
        Number(Boolean(a.task.completion)) - Number(Boolean(b.task.completion)),
    );
    return groups;
  }, [entries]);

  const setTaskError = useCallback((key: string, message: string | null) => {
    setErrorsByKey((current) => {
      if (message) {
        return { ...current, [key]: message };
      }
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  /** Runs a step action, surfacing failures (e.g. git errors) on the card. */
  const runTaskAction = useCallback(
    (key: string, action: () => Promise<unknown>) => {
      setTaskError(key, null);
      setBusyKeys((current) => ({ ...current, [key]: true }));
      action()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message.trim() : "";
          setTaskError(key, message || t("worktreeError"));
        })
        .finally(() => {
          setBusyKeys((current) => {
            const next = { ...current };
            delete next[key];
            return next;
          });
        });
    },
    [setTaskError, t],
  );

  const closeDialog = useCallback(() => setDialog(null), []);
  const handleAddTask = useCallback(() => setDialog({ mode: "create" }), []);
  const handleEdit = useCallback(
    (entry: TaskEntry) => setDialog({ mode: "edit", entry }),
    [],
  );
  const handleConfigureStep = useCallback(
    (step: TaskRunStepId) => setDialog({ mode: "settings", step }),
    [],
  );
  const handleSendBack = useCallback(
    (entry: TaskEntry, toStep: TaskRunStepId) =>
      setDialog({ mode: "sendBack", entry, toStep }),
    [],
  );
  const handleDelete = useCallback(
    (entry: TaskEntry) => {
      setTaskError(entry.key, null);
      deleteTask(entry.projectId, entry.task.id);
    },
    [deleteTask, setTaskError],
  );
  const handleMoveInBacklog = useCallback(
    (entry: TaskEntry, index: number) =>
      moveTaskInBacklog(entry.projectId, entry.task.id, index),
    [moveTaskInBacklog],
  );
  const handleStart = useCallback(
    (entry: TaskEntry) =>
      runTaskAction(entry.key, () => startTask(entry.projectId, entry.task.id)),
    [runTaskAction, startTask],
  );
  const handleAdvance = useCallback(
    (entry: TaskEntry) =>
      runTaskAction(entry.key, () =>
        advanceTask(entry.projectId, entry.task.id),
      ),
    [advanceTask, runTaskAction],
  );
  const handleRetry = useCallback(
    (entry: TaskEntry) =>
      runTaskAction(entry.key, () =>
        retryTaskStep(entry.projectId, entry.task.id),
      ),
    [retryTaskStep, runTaskAction],
  );
  const handleReopenWorktree = useCallback(
    (entry: TaskEntry) =>
      runTaskAction(entry.key, async () => {
        if (!(await reopenTaskWorktree(entry.projectId, entry.task.id))) {
          throw new Error(t("worktreeMissing"));
        }
      }),
    [reopenTaskWorktree, runTaskAction, t],
  );
  const handleRecreateWorktree = useCallback(
    (entry: TaskEntry) =>
      runTaskAction(entry.key, () =>
        recreateTaskWorktree(entry.projectId, entry.task.id),
      ),
    [recreateTaskWorktree, runTaskAction],
  );
  const handleMarkDone = useCallback(
    (entry: TaskEntry) => {
      setTaskError(entry.key, null);
      // Nothing is left to merge or clean up: the worktree is already gone.
      completeTask(entry.projectId, entry.task.id, {
        at: new Date().toISOString(),
        kind: "removed",
        mergeCommit: null,
        prUrl: null,
      });
    },
    [completeTask, setTaskError],
  );
  const handleOpenChat = useCallback(
    (entry: TaskEntry, runId?: string) =>
      openTaskPane(entry.task.id, runId ?? null),
    [openTaskPane],
  );

  const handleComplete = useCallback(
    (entry: TaskEntry) => {
      const { task } = entry;
      setTaskError(entry.key, null);
      const worktreeProject = task.worktreeProjectId
        ? useIdeStore
            .getState()
            .projects.find((project) => project.id === task.worktreeProjectId)
        : null;

      if (worktreeProject?.worktree) {
        // Merge or open a PR. The worktree stays until removed explicitly.
        setDialog({
          discard: false,
          entry,
          mode: "complete",
          project: worktreeProject as WorktreeProject,
        });
        return;
      }

      if (task.worktreeProjectId) {
        setTaskError(entry.key, t("worktreeMissing"));
        return;
      }

      // Tasks that ran in place have no branch to land; just mark them done.
      completeTask(entry.projectId, task.id, {
        at: new Date().toISOString(),
        kind: "merged",
        mergeCommit: null,
        prUrl: null,
      });
    },
    [completeTask, setTaskError, t],
  );

  const handleDiscard = useCallback(
    (entry: TaskEntry) =>
      runTaskAction(entry.key, async () => {
        const findWorktreeProject = () =>
          useIdeStore
            .getState()
            .projects.find(
              (project) => project.id === entry.task.worktreeProjectId,
            );
        // A finished task's worktree is usually closed by now; reopen it so
        // the dialog has a project to work on.
        if (
          !findWorktreeProject() &&
          !(await reopenTaskWorktree(entry.projectId, entry.task.id))
        ) {
          throw new Error(t("worktreeMissing"));
        }
        const worktreeProject = findWorktreeProject();
        if (!worktreeProject?.worktree) {
          throw new Error(t("worktreeMissing"));
        }
        setDialog({
          discard: true,
          entry,
          mode: "complete",
          project: worktreeProject as WorktreeProject,
        });
      }),
    [reopenTaskWorktree, runTaskAction, t],
  );

  const handleWorktreeCompleted = useCallback(
    (entry: TaskEntry, result: WorktreeCompletionResult) => {
      const current = useIdeStore
        .getState()
        .tasks.find((task) => task.id === entry.task.id);
      // Removing a finished task's worktree is cleanup, not a new outcome.
      if (current?.completion) {
        return;
      }
      completeTask(entry.projectId, entry.task.id, {
        at: new Date().toISOString(),
        // A task whose work was already on the base branch is finished
        // without merging again, but the outcome is still "merged".
        kind: result.alreadyMerged ? "merged" : COMPLETION_KINDS[result.action],
        mergeCommit: result.mergeCommit,
        prUrl: result.prUrl,
      });
    },
    [completeTask],
  );

  const handleTaskDialogSubmit = useCallback(
    (value: TaskDialogValue) => {
      const { projectPath, ...fields } = value;
      if (dialog?.mode === "create") {
        if (scopeProject) {
          addTask(scopeProject.id, fields);
        } else if (projectPath) {
          // The project may be closed, which is fine: only running a task
          // loads its project. A folder the app has never seen is registered
          // in the background, without leaving Tasks.
          addTaskToProjectPath(projectPath, fields);
        }
      } else if (dialog?.mode === "edit") {
        updateTask(dialog.entry.projectId, dialog.entry.task.id, fields);
      }
      setDialog(null);
    },
    [addTask, addTaskToProjectPath, dialog, scopeProject, updateTask],
  );

  // Tasks does not depend on what Code has open: a task can go to any open or
  // recent project, or to a folder picked with Browse.
  const projectOptions = useMemo(
    (): TaskProjectOption[] => [
      ...projects.map((project) => ({
        icon: project.icon,
        name: project.name,
        path: project.path,
        recent: false,
        worktreeBranch: project.worktree?.branch ?? null,
      })),
      ...recentProjects.map((project) => ({
        icon: project.icon,
        name: project.name,
        path: project.path,
        recent: true,
        worktreeBranch: null,
      })),
    ],
    [projects, recentProjects],
  );
  // Nothing is preselected unless there is only one choice: a wrong default
  // files the task under the wrong repository.
  const createProjectPath =
    projectOptions.length === 1 ? (projectOptions[0]?.path ?? null) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="-m-2 min-h-0 flex-1 overflow-x-auto p-2">
        {/* Columns share the width up to 1920px; below five 18rem columns
            (plus gaps) the board scrolls instead of squeezing them. */}
        <div className="mx-auto flex h-full w-full min-w-[calc(5*18rem+4*0.5rem)] max-w-[1920px] gap-2">
          {TASK_STEPS.map((step) => (
            <TaskColumn
              busyKeys={busyKeys}
              config={step.id === "backlog" ? null : taskConfig[step.id]}
              entries={entriesByStep[step.id]}
              errorsByKey={errorsByKey}
              key={step.id}
              onAddTask={handleAddTask}
              onAdvance={handleAdvance}
              onComplete={handleComplete}
              onConfigureStep={handleConfigureStep}
              onDelete={handleDelete}
              onDiscard={handleDiscard}
              onEdit={handleEdit}
              onMoveInBacklog={handleMoveInBacklog}
              onMarkDone={handleMarkDone}
              onOpenChat={handleOpenChat}
              onRecreateWorktree={handleRecreateWorktree}
              onReopenWorktree={handleReopenWorktree}
              onRetry={handleRetry}
              onSendBack={handleSendBack}
              onStart={handleStart}
              hostProjectId={scopeProject?.id ?? null}
              selectedTaskId={selectedTaskId}
              showProject={!scopeProject}
              step={step}
            />
          ))}
        </div>
      </div>
      {dialog?.mode === "create" || dialog?.mode === "edit" ? (
        <TaskDialog
          initialValue={
            dialog.mode === "edit"
              ? {
                  description: dialog.entry.task.description,
                  projectPath: null,
                  title: dialog.entry.task.title,
                }
              : { description: "", projectPath: createProjectPath, title: "" }
          }
          key={dialog.mode === "edit" ? dialog.entry.key : "create"}
          mode={dialog.mode}
          onClose={closeDialog}
          onSubmit={handleTaskDialogSubmit}
          // A task never changes project, so only creation across all
          // projects needs to ask where it belongs.
          projectOptions={
            dialog.mode === "create" && !scopeProject ? projectOptions : null
          }
        />
      ) : null}
      {dialog?.mode === "sendBack" ? (
        <TaskSendBackDialog
          findings={getCurrentTaskRun(dialog.entry.task)?.output ?? null}
          onClose={closeDialog}
          onSubmit={(note) => {
            const { entry, toStep } = dialog;
            setDialog(null);
            runTaskAction(entry.key, () =>
              sendTaskBack(entry.projectId, entry.task.id, toStep, note),
            );
          }}
          toStep={dialog.toStep}
        />
      ) : null}
      {dialog?.mode === "settings" ? (
        <TaskSettingsDialog
          config={taskConfig}
          initialStep={dialog.step}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.mode === "complete" ? (
        <CompleteWorktreeDialog
          removeOnly={dialog.discard}
          onCompleted={(result) =>
            handleWorktreeCompleted(dialog.entry, result)
          }
          onOpenChange={(open) => {
            if (!open) {
              setDialog(null);
            }
          }}
          open
          project={dialog.project}
          task={dialog.discard ? undefined : { title: dialog.entry.task.title }}
        />
      ) : null}
    </div>
  );
};
