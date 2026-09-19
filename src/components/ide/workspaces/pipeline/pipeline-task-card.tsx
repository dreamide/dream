import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsRight,
  Ellipsis,
  FilePenLine,
  FolderOpen,
  GitBranch,
  MessageSquare,
  Play,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { memo } from "react";
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
import {
  getEarlierPipelineRunSteps,
  getNextPipelineStep,
} from "@/lib/pipeline-defaults";
import { cn } from "@/lib/utils";
import type { PipelineRunStepId, PipelineTask } from "@/types/ide";
import { useActivityStore } from "../../activity-store";
import { useIdeStore } from "../../ide-store";
import { getCurrentPipelineRun } from "../../store/pipeline-actions";
import { PipelineStepIcon } from "./pipeline-step-icon";
import { PIPELINE_STEP_LABEL_KEYS } from "./pipeline-steps";
import {
  getPipelineStatusDotProps,
  getPipelineTaskStatus,
  isPipelineTaskSettled,
  PIPELINE_STATUS_LABEL_KEYS,
} from "./pipeline-task-status";

export interface PipelineTaskCardProps {
  /** Position among backlog tasks; `null` outside the backlog. */
  backlogIndex: number | null;
  backlogSize: number;
  /** An action on this task is in flight; the primary button shows a spinner. */
  busy: boolean;
  /** Why the last action on this task failed, if it did. */
  error: string | null;
  onAdvance: (taskId: string) => void;
  onComplete: (task: PipelineTask) => void;
  onDelete: (taskId: string) => void;
  onEdit: (task: PipelineTask) => void;
  onMoveInBacklog: (taskId: string, index: number) => void;
  onOpenChat: (taskId: string, runId?: string) => void;
  onReopenWorktree: (taskId: string) => void;
  onRetry: (taskId: string) => void;
  onSendBack: (task: PipelineTask, toStep: PipelineRunStepId) => void;
  onStart: (taskId: string) => void;
  task: PipelineTask;
}

const PipelineTaskCardImpl = ({
  backlogIndex,
  backlogSize,
  busy,
  error,
  onAdvance,
  onComplete,
  onDelete,
  onEdit,
  onMoveInBacklog,
  onOpenChat,
  onReopenWorktree,
  onRetry,
  onSendBack,
  onStart,
  task,
}: PipelineTaskCardProps) => {
  const t = useTranslations("pipeline");
  const format = useFormatter();
  const createdAt = new Date(task.createdAt);
  const currentRun = getCurrentPipelineRun(task);
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
  const activityEntry = useActivityStore((s) =>
    chatId ? s.entries[chatId] : undefined,
  );

  const status = getPipelineTaskStatus({
    activityEntry,
    awaitingAnswer,
    chatExists,
    currentRun,
    pendingSubmit,
    streaming,
    task,
    worktreeOpen,
  });
  const dot = getPipelineStatusDotProps(status);
  const settled = isPipelineTaskSettled(status);
  const liveRunIds = new Set(liveRunIdsKey ? liveRunIdsKey.split(",") : []);
  const liveRuns = task.runs.filter((run) => liveRunIds.has(run.id));
  const nextStep = getNextPipelineStep(task.step);
  const sendBackTargets = settled ? getEarlierPipelineRunSteps(task.step) : [];
  const needsRetry =
    status === "failed" || status === "interrupted" || status === "missing";
  // Approving needs something to hand to the next step.
  const canApprove =
    (status === "awaitingApproval" || status === "waiting") &&
    (Boolean(currentRun?.output) || chatExists);

  const primaryAction =
    status === "idle" && task.step === "backlog"
      ? { icon: Play, label: t("start"), run: () => onStart(task.id) }
      : status === "worktreeClosed"
        ? {
            icon: FolderOpen,
            label: t("reopenWorktree"),
            run: () => onReopenWorktree(task.id),
          }
        : needsRetry
          ? {
              icon: RotateCcw,
              label: t("retryStep"),
              run: () => onRetry(task.id),
            }
          : canApprove && nextStep
            ? {
                icon: ChevronsRight,
                label: t("approveAdvance", {
                  step: t(PIPELINE_STEP_LABEL_KEYS[nextStep]),
                }),
                run: () => onAdvance(task.id),
              }
            : canApprove && task.step === "merge"
              ? {
                  icon: Check,
                  label: t("complete"),
                  run: () => onComplete(task),
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
      data-pipeline-task={task.id}
      onDoubleClick={() => onEdit(task)}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <PipelineStepIcon className="mt-0.5" step={task.step} />
            <h3 className="line-clamp-2 break-words font-medium text-sm leading-5">
              {task.title}
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
                onClick={() => onOpenChat(task.id, liveRuns[0]?.id)}
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
                      onClick={() => onOpenChat(task.id, run.id)}
                    >
                      <PipelineStepIcon step={run.step} />
                      {t(PIPELINE_STEP_LABEL_KEYS[run.step])}
                      <span className="ml-auto text-muted-foreground text-xs tabular-nums">
                        #{index + 1}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
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
                      onClick={() => onSendBack(task, step)}
                    >
                      <PipelineStepIcon step={step} />
                      {t(PIPELINE_STEP_LABEL_KEYS[step])}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            {settled &&
            !primaryIsComplete &&
            (task.step === "review" || task.step === "merge") ? (
              <DropdownMenuItem onClick={() => onComplete(task)}>
                <Check className="size-4" />
                {t("complete")}
              </DropdownMenuItem>
            ) : null}
            {settled && !needsRetry && !task.completion ? (
              <DropdownMenuItem onClick={() => onRetry(task.id)}>
                <RotateCcw className="size-4" />
                {t("retryStep")}
              </DropdownMenuItem>
            ) : null}
            {backlogIndex !== null && backlogSize > 1 ? (
              <>
                <DropdownMenuItem
                  disabled={backlogIndex === 0}
                  onClick={() => onMoveInBacklog(task.id, backlogIndex - 1)}
                >
                  <ArrowUp className="size-4" />
                  {t("moveUp")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={backlogIndex === backlogSize - 1}
                  onClick={() => onMoveInBacklog(task.id, backlogIndex + 1)}
                >
                  <ArrowDown className="size-4" />
                  {t("moveDown")}
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuItem onClick={() => onEdit(task)}>
              <FilePenLine className="size-4" />
              {t("edit")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDelete(task.id)}
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
            {t(PIPELINE_STATUS_LABEL_KEYS[status])}
          </span>
        </div>
      ) : null}
      {error ? (
        <p className="mt-2 break-words text-destructive text-xs leading-5">
          {error}
        </p>
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
            {t(PIPELINE_STATUS_LABEL_KEYS.starting)}
          </Button>
        ) : null}
      </div>
    </article>
  );
};

export const PipelineTaskCard = memo(PipelineTaskCardImpl);
PipelineTaskCard.displayName = "PipelineTaskCard";
