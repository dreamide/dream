import type { StatusDotColor } from "@/components/ui/status-dot";
import type { KanbanCard } from "@/types/ide";
import type { ChatActivity } from "../../activity-store";

export type KanbanCardStatus =
  | "idle"
  | "running"
  | "waiting"
  | "finished"
  | "failed"
  | "interrupted"
  | "missing";

export const getKanbanCardStatus = ({
  activityEntry,
  awaitingAnswer,
  card,
  chatExists,
  streaming,
}: {
  activityEntry: ChatActivity | undefined;
  awaitingAnswer: boolean;
  card: Pick<KanbanCard, "chatId">;
  chatExists: boolean;
  streaming: boolean;
}): KanbanCardStatus => {
  if (!card.chatId) {
    return "idle";
  }

  if (!chatExists) {
    return "missing";
  }

  if (awaitingAnswer) {
    return "waiting";
  }

  if (streaming) {
    return "running";
  }

  switch (activityEntry?.status) {
    case "finished":
    case "failed":
    case "interrupted":
    case "waiting":
      return activityEntry.status;
    default:
      return "idle";
  }
};

export interface KanbanStatusDotProps {
  className?: string;
  color: StatusDotColor;
  pulse: boolean;
}

export const getKanbanStatusDotProps = (
  status: KanbanCardStatus,
): KanbanStatusDotProps => {
  switch (status) {
    case "running":
      return { color: "blue", pulse: true };
    case "waiting":
      return { color: "amber", pulse: true };
    case "finished":
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

export const KANBAN_STATUS_LABEL_KEYS = {
  failed: "statusFailed",
  finished: "statusFinished",
  idle: "statusIdle",
  interrupted: "statusInterrupted",
  missing: "chatMissing",
  running: "statusRunning",
  waiting: "statusWaiting",
} as const satisfies Record<KanbanCardStatus, string>;
