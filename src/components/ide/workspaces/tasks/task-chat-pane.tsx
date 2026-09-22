import { FolderOpen, MessageSquare, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import {
  TASKS_CHAT_PANEL_MAX_WIDTH_PX,
  TASKS_CHAT_PANEL_MIN_WIDTH_PX,
} from "@/lib/task-defaults";
import { cn } from "@/lib/utils";
import type { ChatConfig, Task, TaskStepRun } from "@/types/ide";
import { useActivityStore } from "../../activity-store";
import { ChatPanel } from "../../chat-panel";
import { useIdeStore } from "../../ide-store";
import { getCurrentTaskRun } from "../../store/task-actions";
import {
  SLIDING_PANEL_TRANSITION,
  WORKSPACE_VIEWPORT_BACKGROUND,
} from "../../workspace/constants";
import { WorkspaceSlidingPanel } from "../../workspace/sliding-panel";
import {
  getTaskStatus,
  getTaskStatusDotProps,
  getTaskStatusLabelKey,
} from "./task-status";
import { TaskStepIcon } from "./task-step-icon";
import { TASK_STEP_LABEL_KEYS } from "./task-steps";

/** The task's runs that still have a chat, oldest first. */
export const getTaskRunsWithChats = (
  task: Pick<Task, "runs">,
  chats: Pick<ChatConfig, "id" | "deletedAt">[],
): TaskStepRun[] =>
  task.runs.filter(
    (run) =>
      run.chatId !== null &&
      chats.some((chat) => chat.id === run.chatId && chat.deletedAt === null),
  );

const TaskChatPaneBody = ({
  active,
  runId,
  task,
}: {
  active: boolean;
  runId: string | null;
  task: Task;
}) => {
  const t = useTranslations("tasks");
  const commonT = useTranslations("common");
  const closeTaskPane = useIdeStore((s) => s.closeTaskPane);
  const openTaskPane = useIdeStore((s) => s.openTaskPane);
  const reopenTaskWorktree = useIdeStore((s) => s.reopenTaskWorktree);
  const chats = useIdeStore((s) => s.chats);

  const runs = useMemo(() => getTaskRunsWithChats(task, chats), [chats, task]);
  const selectedRun =
    runs.find((run) => run.id === runId) ?? runs.at(-1) ?? null;
  const chat = useMemo(
    () =>
      chats.find(
        (entry) => entry.id === selectedRun?.chatId && entry.deletedAt === null,
      ) ?? null,
    [chats, selectedRun?.chatId],
  );
  const chatProject = useIdeStore((s) =>
    chat
      ? ([...s.projects, ...s.closedProjects].find(
          (project) => project.id === chat.projectId,
        ) ?? null)
      : null,
  );
  // A chat runs only while its project is open; otherwise it is read-only.
  const projectOpen = useIdeStore((s) =>
    chat ? s.projects.some((project) => project.id === chat.projectId) : false,
  );
  // Once the worktree is removed the chat has moved to the task's own
  // project, which is not where it can run: it stays read-only for good.
  const worktreeRemoved =
    task.worktreeProjectId !== null &&
    chat?.projectId !== task.worktreeProjectId;
  const worktreeMissing = useIdeStore(
    (s) => s.missingTaskWorktrees[task.id] !== undefined,
  );
  const canReopen =
    !projectOpen &&
    !worktreeRemoved &&
    !worktreeMissing &&
    task.worktreeProjectId !== null &&
    !task.completion;

  // The same status the card shows.
  const currentRun = getCurrentTaskRun(task);
  const currentChatId = currentRun?.chatId ?? null;
  const chatExists = useIdeStore((s) =>
    Boolean(
      currentChatId &&
        s.chats.some(
          (entry) => entry.id === currentChatId && entry.deletedAt === null,
        ),
    ),
  );
  const streaming = useIdeStore((s) =>
    Boolean(currentChatId && s.streamingChatIds[currentChatId]),
  );
  const awaitingAnswer = useIdeStore((s) =>
    Boolean(currentChatId && s.awaitingAnswerChatIds[currentChatId]),
  );
  const pendingSubmit = useIdeStore((s) =>
    Boolean(currentChatId && s.pendingChatSubmitByChatId[currentChatId]),
  );
  const worktreeOpen = useIdeStore(
    (s) =>
      !task.worktreeProjectId ||
      s.projects.some((project) => project.id === task.worktreeProjectId),
  );
  const activityEntry = useActivityStore((s) =>
    currentChatId ? s.entries[currentChatId] : undefined,
  );
  const status = getTaskStatus({
    activityEntry,
    awaitingAnswer,
    chatExists,
    currentRun,
    pendingSubmit,
    streaming,
    task,
    worktreeMissing,
    worktreeOpen,
  });
  const dot = getTaskStatusDotProps(status);

  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const handleReopen = useCallback(async () => {
    setReopening(true);
    setReopenError(null);
    try {
      if (!(await reopenTaskWorktree(task.projectId, task.id))) {
        setReopenError(t("worktreeMissing"));
      }
    } catch (error) {
      setReopenError(
        error instanceof Error ? error.message : t("worktreeMissing"),
      );
    } finally {
      setReopening(false);
    }
  }, [reopenTaskWorktree, t, task.id, task.projectId]);

  // Step labels repeat when a step ran more than once; number those.
  const runLabels = useMemo(() => {
    const seen = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const run of runs) {
      counts.set(run.step, (counts.get(run.step) ?? 0) + 1);
    }
    return runs.map((run) => {
      const ordinal = (seen.get(run.step) ?? 0) + 1;
      seen.set(run.step, ordinal);
      return (counts.get(run.step) ?? 0) > 1 ? ` #${ordinal}` : "";
    });
  }, [runs]);

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ backgroundColor: WORKSPACE_VIEWPORT_BACKGROUND }}
    >
      {/* Styled like the composer: a white card on a gray strip. */}
      <div className="shrink-0 px-2 pt-2">
        <div className="mx-auto w-full max-w-[700px] overflow-hidden rounded-lg border border-surface-300 bg-surface-50 shadow-md dark:border-surface-700 dark:bg-surface-900">
          <div className="-mx-px -mt-px flex w-[calc(100%+2px)] items-start gap-2 rounded-lg border border-surface-300 bg-background px-3 py-2 dark:border-surface-700">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <TaskStepIcon step={task.step} />
                <h2 className="truncate font-medium text-sm">{task.title}</h2>
              </div>
              {task.step !== "backlog" ? (
                <div className="mt-1 flex items-center gap-1.5 text-muted-foreground text-xs">
                  <StatusDot
                    className={dot.className}
                    color={dot.color}
                    pulse={dot.pulse}
                  />
                  <span className="truncate">
                    {t(getTaskStatusLabelKey(status, task.step))}
                  </span>
                </div>
              ) : null}
            </div>
            <Button
              aria-label={commonT("close")}
              className="size-7 shrink-0 text-muted-foreground"
              onClick={closeTaskPane}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className="size-4" />
            </Button>
          </div>

          {runs.length > 1 ? (
            <div
              className="flex items-center overflow-x-auto px-2 py-1.5"
              role="tablist"
            >
              {runs.map((run, index) => {
                const selected = run.id === selectedRun?.id;
                return (
                  <button
                    aria-selected={selected}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-xs transition-colors",
                      selected
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                    key={run.id}
                    onClick={() => openTaskPane(task.id, run.id)}
                    role="tab"
                    type="button"
                  >
                    <TaskStepIcon step={run.step} />
                    {t(TASK_STEP_LABEL_KEYS[run.step])}
                    {runLabels[index]}
                  </button>
                );
              })}
            </div>
          ) : null}

          {chat && !projectOpen ? (
            <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-muted-foreground text-xs">
              <span>
                {worktreeRemoved
                  ? t("chatWorktreeRemoved")
                  : t("chatWorktreeClosed")}
              </span>
              {canReopen ? (
                <Button
                  className="h-6 gap-1 px-2 text-xs"
                  disabled={reopening}
                  onClick={() => void handleReopen()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {reopening ? (
                    <Spinner className="size-3" />
                  ) : (
                    <FolderOpen className="size-3.5" />
                  )}
                  {t("reopenWorktree")}
                </Button>
              ) : null}
              {reopenError ? (
                <span className="w-full text-destructive">{reopenError}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {chat && chatProject ? (
          <ChatPanel
            chat={chat}
            isActive={active}
            isProjectActive={active && projectOpen}
            key={chat.id}
            project={chatProject}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground text-sm">
            <MessageSquare className="size-5" />
            {t("noChatsYet")}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * The right-hand chat pane of the Tasks workspace: a task's step chats, one
 * tab per run, shown where the task lives instead of in Code. The chat itself
 * runs in the chat runtime, so the pane is only a view of it.
 */
const TaskChatPaneImpl = ({ active }: { active: boolean }) => {
  const tasksPane = useIdeStore((s) => s.tasksPane);
  const task = useIdeStore((s) =>
    tasksPane
      ? (s.tasks.find((entry) => entry.id === tasksPane.taskId) ?? null)
      : null,
  );
  const width = useIdeStore((s) => s.tasksChatPanelWidth);
  const setTasksChatPanelWidth = useIdeStore((s) => s.setTasksChatPanelWidth);
  const closeTaskPane = useIdeStore((s) => s.closeTaskPane);
  const widthRef = useRef(width);
  widthRef.current = width;

  // The pane cannot outlive its task.
  useEffect(() => {
    if (tasksPane && !task) {
      closeTaskPane();
    }
  }, [closeTaskPane, task, tasksPane]);

  const open = tasksPane !== null && task !== null;

  return (
    <WorkspaceSlidingPanel
      className="z-20"
      contentClassName="pl-2"
      contentMinWidth={TASKS_CHAT_PANEL_MIN_WIDTH_PX}
      maxWidth={TASKS_CHAT_PANEL_MAX_WIDTH_PX}
      minWidth={TASKS_CHAT_PANEL_MIN_WIDTH_PX}
      onHandleDoubleClick={closeTaskPane}
      onResizeEnd={setTasksChatPanelWidth}
      open={open}
      reserveSpace
      side="right"
      transition={SLIDING_PANEL_TRANSITION}
      width={width}
      widthRef={widthRef}
    >
      {open && task && tasksPane ? (
        <TaskChatPaneBody
          active={active}
          key={task.id}
          runId={tasksPane.runId}
          task={task}
        />
      ) : null}
    </WorkspaceSlidingPanel>
  );
};

export const TaskChatPane = memo(TaskChatPaneImpl);
TaskChatPane.displayName = "TaskChatPane";
