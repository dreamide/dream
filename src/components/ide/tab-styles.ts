import { cn } from "@/lib/utils";

export const tabSurfaceClassName = (active: boolean) =>
  cn(
    "rounded-sm border text-xs transition-colors",
    active
      ? "border-surface-300 dark:border-surface-800 bg-background dark:bg-muted text-foreground shadow-sm"
      : "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground group-hover:bg-muted group-hover:text-foreground",
  );
