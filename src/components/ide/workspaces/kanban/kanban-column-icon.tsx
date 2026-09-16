import { Circle, CircleCheck, CircleDashed, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { KanbanColumnId } from "@/types/ide";

const COLUMN_ICONS = {
  backlog: { icon: CircleDashed, color: "text-muted-foreground/70" },
  ready: { icon: Circle, color: "text-muted-foreground" },
  inProgress: { icon: CircleDot, color: "text-amber-500 dark:text-amber-400" },
  review: { icon: CircleDot, color: "text-emerald-500 dark:text-emerald-400" },
  done: { icon: CircleCheck, color: "text-indigo-500 dark:text-indigo-400" },
} as const;

export const KanbanColumnIcon = ({
  column,
  className,
}: {
  column: KanbanColumnId;
  className?: string;
}) => {
  const { icon: Icon, color } = COLUMN_ICONS[column];
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", color, className)}
      strokeWidth={2}
    />
  );
};
