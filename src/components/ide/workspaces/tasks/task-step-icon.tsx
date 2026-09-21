import {
  CircleDashed,
  GitMerge,
  Hammer,
  ListChecks,
  SearchCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskStepId } from "@/types/ide";

const STEP_ICONS = {
  backlog: { icon: CircleDashed, color: "text-muted-foreground/70" },
  plan: { icon: ListChecks, color: "text-sky-500 dark:text-sky-400" },
  build: { icon: Hammer, color: "text-amber-500 dark:text-amber-400" },
  review: {
    icon: SearchCheck,
    color: "text-emerald-500 dark:text-emerald-400",
  },
  merge: { icon: GitMerge, color: "text-indigo-500 dark:text-indigo-400" },
} as const;

export const TaskStepIcon = ({
  step,
  className,
}: {
  step: TaskStepId;
  className?: string;
}) => {
  const { icon: Icon, color } = STEP_ICONS[step];
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-3.5 shrink-0", color, className)}
      strokeWidth={2}
    />
  );
};
