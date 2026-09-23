import { MessageSquare, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  TASKS_CHAT_PANEL_MAX_WIDTH_PX,
  TASKS_CHAT_PANEL_MIN_WIDTH_PX,
} from "@/lib/task-defaults";
import { cn } from "@/lib/utils";
import type { ChatConfig, Task, TaskStepRun } from "@/types/ide";
import { ChatPanel } from "../../chat-panel";
import { useIdeStore } from "../../ide-store";
import {
  SLIDING_PANEL_TRANSITION,
  WORKSPACE_VIEWPORT_BACKGROUND,
} from "../../workspace/constants";
import { WorkspaceSlidingPanel } from "../../workspace/sliding-panel";
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
  // A closed worktree project is reopened in the background so the chat can
  // be used right away; one that is gone from disk is left alone.
  useEffect(() => {
    if (
      chatProject &&
      !projectOpen &&
      !worktreeRemoved &&
      !worktreeMissing &&
      !task.completion
    ) {
      useIdeStore.getState().addProject(chatProject.path, { activate: false });
    }
  }, [
    chatProject,
    projectOpen,
    task.completion,
    worktreeMissing,
    worktreeRemoved,
  ]);

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
    <div className="flex h-full min-h-0 flex-col">
      {/* One panel for the whole pane, like the workspace side panels. */}
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-surface-300 shadow-md dark:border-surface-700"
        style={{ backgroundColor: WORKSPACE_VIEWPORT_BACKGROUND }}
      >
        {/* The header spans the panel's full width. */}
        <div className="shrink-0">
          <div className="flex min-h-[50px] items-center gap-2 border-surface-300 border-b bg-background px-3 py-2 dark:border-surface-700">
            <div className="flex min-h-7 min-w-0 flex-1 items-center gap-1.5">
              <TaskStepIcon step={task.step} />
              <h2 className="truncate font-medium text-sm">{task.title}</h2>
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
            <div className="overflow-x-auto px-2 py-1.5" role="tablist">
              <div className="mx-auto flex w-max items-center gap-1">
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
            </div>
          ) : null}

          {chat && worktreeRemoved ? (
            <div className="px-3 py-1.5 text-center text-muted-foreground text-xs">
              {t("chatWorktreeRemoved")}
            </div>
          ) : null}
        </div>

        <div className="min-h-0 flex-1">
          {chat && chatProject ? (
            <ChatPanel
              chat={chat}
              isActive={active}
              isProjectActive={active && projectOpen && !worktreeRemoved}
              key={chat.id}
              project={chatProject}
              readOnly={worktreeRemoved}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground text-sm">
              <MessageSquare className="size-5" />
              {t("noChatsYet")}
            </div>
          )}
        </div>
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
      contentMinWidth={TASKS_CHAT_PANEL_MIN_WIDTH_PX}
      maxWidth={TASKS_CHAT_PANEL_MAX_WIDTH_PX}
      minWidth={TASKS_CHAT_PANEL_MIN_WIDTH_PX}
      onHandleDoubleClick={closeTaskPane}
      onResizeEnd={setTasksChatPanelWidth}
      open={open}
      // The panel fills the pane edge to edge, so its shadow needs to fall
      // outside the box instead of being clipped by it.
      panelClassName="overflow-visible"
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
