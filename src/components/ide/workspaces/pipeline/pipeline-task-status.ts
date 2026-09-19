import type { StatusDotColor } from "@/components/ui/status-dot";
import type { PipelineStepRun, PipelineTask } from "@/types/ide";
import type { ChatActivity } from "../../activity-store";

export type PipelineTaskStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting"
  | "awaitingApproval"
  | "failed"
  | "interrupted"
  | "missing"
  | "worktreeClosed"
  | "done";

/**
 * Status is derived from the step chat rather than stored, so it can never
 * disagree with what the agent actually did.
 */
export const getPipelineTaskStatus = ({
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
  currentRun: Pick<PipelineStepRun, "chatId" | "finishedAt"> | null;
  pendingSubmit: boolean;
  streaming: boolean;
  task: Pick<PipelineTask, "completion" | "step" | "worktreeProjectId">;
  /** Whether the task's worktree project is open (true when it has none). */
  worktreeOpen: boolean;
}): PipelineTaskStatus => {
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

  if (currentRun.finishedAt) {
    return "awaitingApproval";
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
export const isPipelineTaskSettled = (status: PipelineTaskStatus): boolean =>
  status === "waiting" ||
  status === "awaitingApproval" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "missing";

export interface PipelineStatusDotProps {
  className?: string;
  color: StatusDotColor;
  pulse: boolean;
}

export const getPipelineStatusDotProps = (
  status: PipelineTaskStatus,
): PipelineStatusDotProps => {
  switch (status) {
    case "starting":
    case "running":
      return { color: "blue", pulse: true };
    case "waiting":
      return { color: "amber", pulse: true };
    case "awaitingApproval":
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

export const PIPELINE_STATUS_LABEL_KEYS = {
  awaitingApproval: "statusAwaitingApproval",
  done: "statusDone",
  failed: "statusFailed",
  idle: "statusIdle",
  interrupted: "statusInterrupted",
  missing: "chatMissing",
  running: "statusRunning",
  starting: "statusStarting",
  waiting: "statusWaiting",
  worktreeClosed: "statusWorktreeClosed",
} as const satisfies Record<PipelineTaskStatus, string>;
