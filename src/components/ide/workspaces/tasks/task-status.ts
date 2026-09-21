import type { StatusDotColor } from "@/components/ui/status-dot";
import { getTaskReviewVerdict } from "@/lib/task-defaults";
import type { Task, TaskStepRun } from "@/types/ide";
import type { ChatActivity } from "../../activity-store";

export type TaskStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting"
  | "awaitingApproval"
  | "changesRequested"
  | "failed"
  | "interrupted"
  | "missing"
  | "worktreeClosed"
  | "done";

/**
 * Status is derived from the step chat rather than stored, so it can never
 * disagree with what the agent actually did.
 */
export const getTaskStatus = ({
  activityEntry,
  awaitingAnswer,
  chatExists,
  currentRun,
  pendingSubmit,
  streaming,
  task,
  worktreeOpen,
}: {
  activityEntry: ChatActivity | undefined;
  awaitingAnswer: boolean;
  chatExists: boolean;
  currentRun:
    | (Pick<TaskStepRun, "chatId" | "finishedAt"> &
        Partial<Pick<TaskStepRun, "commitError" | "output" | "step">>)
    | null;
  pendingSubmit: boolean;
  streaming: boolean;
  task: Pick<Task, "completion" | "step" | "worktreeProjectId">;
  /** Whether the task's worktree project is open (true when it has none). */
  worktreeOpen: boolean;
}): TaskStatus => {
  if (task.completion) {
    return "done";
  }

  if (task.step === "backlog" || !currentRun) {
    return "idle";
  }

  if (task.worktreeProjectId && !worktreeOpen) {
    return "worktreeClosed";
  }

  if (awaitingAnswer) {
    return "waiting";
  }

  if (streaming) {
    return "running";
  }

  if (pendingSubmit) {
    return "starting";
  }

  // The agent finished, but git rejected the app's commit of its work: the
  // task cannot move on until that is fixed (retry hands it back to the agent).
  if (currentRun.commitError) {
    return "failed";
  }

  if (currentRun.finishedAt) {
    // The reviewer asked for changes, so this is not simply ready to approve.
    return currentRun.step === "review" &&
      getTaskReviewVerdict(currentRun.output) === "changes"
      ? "changesRequested"
      : "awaitingApproval";
  }

  if (!currentRun.chatId || !chatExists) {
    return "missing";
  }

  switch (activityEntry?.status) {
    case "failed":
    case "interrupted":
    case "waiting":
      return activityEntry.status;
    case "finished":
      return "awaitingApproval";
    default:
      // The queued prompt never ran (e.g. the app restarted first).
      return "interrupted";
  }
};

/** The agent is not working, so the user may approve, send back or retry. */
export const isTaskSettled = (status: TaskStatus): boolean =>
  status === "waiting" ||
  status === "awaitingApproval" ||
  status === "changesRequested" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "missing";

export interface TaskStatusDotProps {
  className?: string;
  color: StatusDotColor;
  pulse: boolean;
}

export const getTaskStatusDotProps = (
  status: TaskStatus,
): TaskStatusDotProps => {
  switch (status) {
    case "starting":
    case "running":
      return { color: "blue", pulse: true };
    case "waiting":
      return { color: "amber", pulse: true };
    case "awaitingApproval":
    case "changesRequested":
      return { color: "amber", pulse: false };
    case "done":
      return { color: "green", pulse: false };
    case "failed":
      return { className: "bg-destructive", color: "green", pulse: false };
    default:
      return {
        className: "bg-muted-foreground/40",
        color: "green",
        pulse: false,
      };
  }
};

export const TASK_STATUS_LABEL_KEYS = {
  awaitingApproval: "statusAwaitingApproval",
  changesRequested: "statusChangesRequested",
  done: "statusDone",
  failed: "statusFailed",
  idle: "statusIdle",
  interrupted: "statusInterrupted",
  missing: "chatMissing",
  running: "statusRunning",
  starting: "statusStarting",
  waiting: "statusWaiting",
  worktreeClosed: "statusWorktreeClosed",
} as const satisfies Record<TaskStatus, string>;
