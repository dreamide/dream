import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronsRight,
  Ellipsis,
  FilePenLine,
  FolderOpen,
  FolderSync,
  FolderX,
  GitBranch,
  MessageSquare,
  Play,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { memo, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { getEarlierTaskRunSteps, getNextTaskStep } from "@/lib/task-defaults";
import { cn } from "@/lib/utils";
import type { TaskEntry, TaskRunStepId } from "@/types/ide";
import { useActivityStore } from "../../activity-store";
import { ProjectTabIcon } from "../../header/project-tab-icon";
import { useIdeStore } from "../../ide-store";
import { getCurrentTaskRun } from "../../store/task-actions";
import { TaskDeliveryBadge, useTaskDelivery } from "./task-delivery";
import {
  getTaskStatus,
  getTaskStatusDotProps,
  getTaskStatusLabelKey,
  isTaskSettled,
  TASK_STATUS_LABEL_KEYS,
} from "./task-status";
import { TaskStepIcon } from "./task-step-icon";
import { TASK_STEP_LABEL_KEYS } from "./task-steps";

export interface TaskCardProps {
  /** Position among its project's backlog tasks; `null` outside the backlog. */
  backlogIndex: number | null;
  /** How many backlog tasks the owning project has. */
  backlogSize: number;
  /** An action on this task is in flight; the primary button shows a spinner. */
  busy: boolean;
  /** The task with the project that owns it; handlers receive it back. */
  entry: TaskEntry;
  /** Why the last action on this task failed, if it did. */
  error: string | null;
  onAdvance: (entry: TaskEntry) => void;
  onComplete: (entry: TaskEntry) => void;
  onDelete: (entry: TaskEntry) => void;
  /** Throws the task's work away: the worktree, optionally the branch. */
  onDiscard: (entry: TaskEntry) => void;
  onEdit: (entry: TaskEntry) => void;
  onMoveInBacklog: (entry: TaskEntry, index: number) => void;
  onOpenChat: (entry: TaskEntry, runId?: string) => void;
  /** Ends a task whose worktree is gone, e.g. because it was merged by hand. */
  onMarkDone: (entry: TaskEntry) => void;
  onRecreateWorktree: (entry: TaskEntry) => void;
  onReopenWorktree: (entry: TaskEntry) => void;
  onRetry: (entry: TaskEntry) => void;
  onSendBack: (entry: TaskEntry, toStep: TaskRunStepId) => void;
  onStart: (entry: TaskEntry) => void;
  /** Names the owning project on the card; set when several are in view. */
  showProject: boolean;
}

const TaskCardImpl = ({
  backlogIndex,
  backlogSize,
  busy,
  entry,
  error,
  onAdvance,
  onComplete,
  onDelete,
  onDiscard,
  onEdit,
  onMoveInBacklog,
  onMarkDone,
  onOpenChat,
  onRecreateWorktree,
  onReopenWorktree,
  onRetry,
  onSendBack,
  onStart,
  showProject,
}: TaskCardProps) => {
  const t = useTranslations("tasks");
  const format = useFormatter();
  const { project, task } = entry;
  const createdAt = new Date(task.createdAt);
  const currentRun = getCurrentTaskRun(task);
  const chatId = currentRun?.chatId ?? null;

  const chatExists = useIdeStore((s) =>
    Boolean(
      chatId &&
        s.chats.some((chat) => chat.id === chatId && chat.deletedAt === null),
    ),
  );
  // A stable string so the selector does not return a fresh array each time.
  const liveRunIdsKey = useIdeStore((s) =>
    task.runs
      .filter((run) =>
        s.chats.some(
          (chat) => chat.id === run.chatId && chat.deletedAt === null,
        ),
      )
      .map((run) => run.id)
      .join(","),
  );
  const streaming = useIdeStore((s) =>
    Boolean(chatId && s.streamingChatIds[chatId]),
  );
  const awaitingAnswer = useIdeStore((s) =>
    Boolean(chatId && s.awaitingAnswerChatIds[chatId]),
  );
  const pendingSubmit = useIdeStore((s) =>
    Boolean(chatId && s.pendingChatSubmitByChatId[chatId]),
  );
  const worktreeOpen = useIdeStore(
    (s) =>
      !task.worktreeProjectId ||
      s.projects.some((project) => project.id === task.worktreeProjectId),
  );
  const missingWorktree = useIdeStore(
    (s) => s.missingTaskWorktrees[task.id] ?? null,
  );
  const worktreeMissing = missingWorktree !== null;
  const checkTaskWorktree = useIdeStore((s) => s.checkTaskWorktree);
  // A closed worktree may be gone from disk. Looking once saves offering a
  // Reopen (or Remove) that cannot work; failures to look just leave the
  // card as it is.
  useEffect(() => {
    if (!worktreeOpen) {
      void checkTaskWorktree(entry.projectId, task.id).catch(() => {});
    }
  }, [checkTaskWorktree, entry.projectId, task.id, worktreeOpen]);
  const activityEntry = useActivityStore((s) =>
    chatId ? s.entries[chatId] : undefined,
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
  // "Done" means merged locally; whether it was pushed is a separate fact.
  const mergedCommit =
    task.completion?.kind === "merged" ? task.completion.mergeCommit : null;
  const delivery = useTaskDelivery({
    branch: task.baseRef,
    commit: mergedCommit,
    enabled: mergedCommit !== null,
    projectPath: project.path,
  });
  const dot = getTaskStatusDotProps(status);
  const settled = isTaskSettled(status);
  // Deleting mid-run would orphan a live agent still editing the worktree.
  const canDelete = !busy && status !== "starting" && status !== "running";
  const liveRunIds = new Set(liveRunIdsKey ? liveRunIdsKey.split(",") : []);
  const liveRuns = task.runs.filter((run) => liveRunIds.has(run.id));
  const latestLiveRun = liveRuns.at(-1) ?? null;
  const nextStep = getNextTaskStep(task.step);
  const sendBackTargets = settled ? getEarlierTaskRunSteps(task.step) : [];
  const needsRetry =
    status === "failed" || status === "interrupted" || status === "missing";
  // Approving needs something to hand to the next step.
  const changesRequested = status === "changesRequested";
  const canApprove =
    (status === "awaitingApproval" ||
      status === "waiting" ||
      changesRequested) &&
    (Boolean(currentRun?.output) || chatExists);

  const primaryAction =
    status === "idle" && task.step === "backlog"
      ? { icon: Play, label: t("start"), run: () => onStart(entry) }
      : status === "worktreeMissing"
        ? missingWorktree?.branchExists
          ? {
              // The branch outlived the folder, so the work comes back.
              icon: FolderSync,
              label: t("recreateWorktree"),
              run: () => onRecreateWorktree(entry),
            }
          : {
              // Branch and worktree are both gone: nothing can be recreated.
              // That is what a task merged and cleaned up by hand looks like.
              icon: Check,
              label: t("markDone"),
              run: () => onMarkDone(entry),
            }
        : status === "worktreeClosed"
          ? {
              icon: FolderOpen,
              label: t("reopenWorktree"),
              run: () => onReopenWorktree(entry),
            }
          : changesRequested
            ? {
                // The reviewer's findings go back to the builder; approving
                // anyway stays available from the menu.
                icon: Undo2,
                label: t("sendBackTo", {
                  step: t(TASK_STEP_LABEL_KEYS.build),
                }),
                run: () => onSendBack(entry, "build"),
              }
            : needsRetry
              ? {
                  icon: RotateCcw,
                  label: t("retryStep"),
                  run: () => onRetry(entry),
                }
              : canApprove && nextStep
                ? {
                    icon: ChevronsRight,
                    label: t("approveAdvance", {
                      step: t(TASK_STEP_LABEL_KEYS[nextStep]),
                    }),
                    run: () => onAdvance(entry),
                  }
                : canApprove && task.step === "merge"
                  ? {
                      icon: ArrowRight,
                      label: t("complete"),
                      run: () => onComplete(entry),
                    }
                  : null;

  // Completing is also offered from the menu, so a task can skip the merge
  // agent (or a failed one) and go straight to merge / PR.
  const primaryIsComplete = canApprove && task.step === "merge" && !needsRetry;

  return (
    <article
      className={cn(
        "group/card shrink-0 select-none rounded-md border border-surface-300 bg-background p-3 text-left text-foreground shadow-sm transition-colors hover:border-surface-400 dark:border-surface-700 dark:hover:border-surface-600",
        status === "done" && "opacity-60",
      )}
      data-task={task.id}
      data-project-id={entry.projectId}
      onDoubleClick={() => onEdit(entry)}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {showProject ? (
            <div
              className="mb-1.5 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
              title={project.path}
            >
              <ProjectTabIcon
                icon={project.icon}
                projectName={project.name}
                projectPath={project.path}
              />
              <span className="truncate">{project.name}</span>
            </div>
          ) : null}
          <div className="flex items-start gap-2">
            <TaskStepIcon className="mt-0.5" step={task.step} />
            <h3 className="line-clamp-2 break-words font-medium text-sm leading-5">
              {latestLiveRun ? (
                // Runs are stored oldest first, so the last live one is the
                // chat the task was most recently working in.
                <button
                  className="cursor-pointer text-left hover:underline focus-visible:underline focus-visible:outline-none"
                  onClick={() => onOpenChat(entry, latestLiveRun.id)}
                  // The card's double-click opens the edit dialog.
                  onDoubleClick={(event) => event.stopPropagation()}
                  title={t("openChat")}
                  type="button"
                >
                  {task.title}
                </button>
              ) : (
                task.title
              )}
            </h3>
          </div>
          {task.description ? (
            <p className="mt-2 line-clamp-3 whitespace-pre-line text-muted-foreground text-xs leading-5">
              {task.description}
            </p>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t("taskActions")}
                className="size-6 shrink-0 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100 data-[state=open]:text-foreground data-[state=open]:opacity-100"
                size="icon-xs"
                type="button"
                variant="ghost"
              />
            }
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {liveRuns.length === 1 ? (
              <DropdownMenuItem
                onClick={() => onOpenChat(entry, liveRuns[0]?.id)}
              >
                <MessageSquare className="size-4" />
                {t("openChat")}
              </DropdownMenuItem>
            ) : null}
            {liveRuns.length > 1 ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <MessageSquare className="size-4" />
                  {t("openChat")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {liveRuns.map((run, index) => (
                    <DropdownMenuItem
                      key={run.id}
                      onClick={() => onOpenChat(entry, run.id)}
                    >
                      <TaskStepIcon step={run.step} />
                      {t(TASK_STEP_LABEL_KEYS[run.step])}
                      <span className="ml-auto text-muted-foreground text-xs tabular-nums">
                        #{index + 1}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {changesRequested && canApprove && nextStep ? (
              <DropdownMenuItem onClick={() => onAdvance(entry)}>
                <ChevronsRight className="size-4" />
                {t("approveAdvance", {
                  step: t(TASK_STEP_LABEL_KEYS[nextStep]),
                })}
              </DropdownMenuItem>
            ) : null}
            {sendBackTargets.length > 0 && !task.completion ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Undo2 className="size-4" />
                  {t("sendBack")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {sendBackTargets.map((step) => (
                    <DropdownMenuItem
                      key={step}
                      onClick={() => onSendBack(entry, step)}
                    >
                      <TaskStepIcon step={step} />
                      {t(TASK_STEP_LABEL_KEYS[step])}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {settled &&
            !primaryIsComplete &&
            (task.step === "review" || task.step === "merge") ? (
              <DropdownMenuItem onClick={() => onComplete(entry)}>
                <ArrowRight className="size-4" />
                {t("complete")}
              </DropdownMenuItem>
            ) : null}
            {settled && !needsRetry && !task.completion ? (
              <DropdownMenuItem onClick={() => onRetry(entry)}>
                <RotateCcw className="size-4" />
                {t("retryStep")}
              </DropdownMenuItem>
            ) : null}
            {backlogIndex !== null && backlogSize > 1 ? (
              <>
                <DropdownMenuItem
                  disabled={backlogIndex === 0}
                  onClick={() => onMoveInBacklog(entry, backlogIndex - 1)}
                >
                  <ArrowUp className="size-4" />
                  {t("moveUp")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={backlogIndex === backlogSize - 1}
                  onClick={() => onMoveInBacklog(entry, backlogIndex + 1)}
                >
                  <ArrowDown className="size-4" />
                  {t("moveDown")}
                </DropdownMenuItem>
              </>
            ) : null}
            {status === "worktreeMissing" ? (
              // Often the work was merged by hand and the worktree removed
              // with it; then the task is simply finished.
              <DropdownMenuItem onClick={() => onMarkDone(entry)}>
                <Check className="size-4" />
                {t("markDone")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={() => onEdit(entry)}>
              <FilePenLine className="size-4" />
              {t("edit")}
            </DropdownMenuItem>
            {task.worktreeProjectId &&
            !worktreeMissing &&
            (task.completion || settled) ? (
              // Shipping never touches the worktree; removing it is its own
              // action: cleanup once the task is done, discarding before.
              <DropdownMenuItem onClick={() => onDiscard(entry)}>
                <FolderX className="size-4" />
                {task.completion ? t("removeTaskWorktree") : t("discardWork")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!canDelete}
              onClick={() => onDelete(entry)}
              variant="destructive"
            >
              <Trash2 className="size-4" />
              {t("delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {task.step !== "backlog" ? (
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
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
      {delivery?.branchExists && delivery.pushed !== null ? (
        <TaskDeliveryBadge status={delivery} />
      ) : null}
      {error ? (
        <p className="mt-2 break-words text-destructive text-xs leading-5">
          {error}
        </p>
      ) : currentRun?.commitError ? (
        // Hook output can be long; it scrolls rather than stretching the card.
        <div className="mt-2 text-destructive text-xs leading-5">
          <p className="font-medium">{t("commitRejected")}</p>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4">
            {currentRun.commitError}
          </pre>
        </div>
      ) : null}
      {task.branch ? (
        <div
          className="mt-1.5 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
          title={task.branch}
        >
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate font-mono">{task.branch}</span>
        </div>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        {Number.isFinite(createdAt.getTime()) ? (
          <time
            className="text-muted-foreground text-xs"
            dateTime={task.createdAt}
            title={format.dateTime(createdAt, { dateStyle: "long" })}
          >
            {format.dateTime(createdAt, { month: "short", day: "numeric" })}
          </time>
        ) : null}
        {primaryAction ? (
          <Button
            aria-busy={busy}
            className="ml-auto h-7 gap-1.5 px-2 text-xs"
            disabled={busy}
            onClick={primaryAction.run}
            onDoubleClick={(event) => event.stopPropagation()}
            size="sm"
            type="button"
            variant={needsRetry ? "outline" : "default"}
          >
            {busy ? (
              <Spinner className="size-3.5" />
            ) : (
              <primaryAction.icon className="size-3.5" />
            )}
            {primaryAction.label}
          </Button>
        ) : status === "starting" ? (
          // The action itself settles quickly; the step chat then takes a
          // moment to spin up, so keep showing progress until it is running.
          <Button
            aria-busy
            className="ml-auto h-7 gap-1.5 px-2 text-xs"
            disabled
            size="sm"
            type="button"
            variant="default"
          >
            <Spinner className="size-3.5" />
            {t(TASK_STATUS_LABEL_KEYS.starting)}
          </Button>
        ) : null}
      </div>
    </article>
  );
};

/**
 * Entries are rebuilt whenever any project changes, and a project object is
 * replaced on every UI tweak. Only what the card renders counts: the task
 * itself plus its owner's id, name, path and icon. An entry that matches on
 * those is interchangeable, so handlers may safely keep receiving the old one.
 */
const isSameEntry = (previous: TaskEntry, next: TaskEntry) =>
  previous.task === next.task &&
  previous.projectId === next.projectId &&
  previous.project.name === next.project.name &&
  previous.project.path === next.project.path &&
  previous.project.icon === next.project.icon;

export const TaskCard = memo(TaskCardImpl, (previous, next) => {
  const keys = Object.keys(next) as (keyof TaskCardProps)[];
  return (
    keys.length === Object.keys(previous).length &&
    keys.every((key) =>
      key === "entry"
        ? isSameEntry(previous.entry, next.entry)
        : Object.is(previous[key], next[key]),
    )
  );
});
TaskCard.displayName = "TaskCard";
