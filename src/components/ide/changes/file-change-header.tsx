import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type {
  ProjectGitChangeStatus,
  ProjectGitStatusEntry,
} from "@/types/ide";
import { MaterialFileIcon } from "../material-file-icon";

const CHANGE_STATUS_LABEL_CLASSNAMES: Partial<
  Record<ProjectGitChangeStatus, string>
> = {
  deleted:
    "rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold leading-4 text-rose-600 ring-1 ring-rose-200 dark:bg-destructive-surface dark:text-rose-300 dark:ring-destructive-border-strong",
  untracked:
    "rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold leading-4 text-emerald-700 ring-1 ring-emerald-200 dark:bg-success-surface dark:text-emerald-300 dark:ring-success-border",
};

const formatChangeCount = (value: number, prefix: "+" | "-") =>
  `${prefix}${value}`;

export function FileChangeHeader({
  change,
  expanded,
  onToggle,
  actions,
}: {
  change: ProjectGitStatusEntry;
  expanded: boolean;
  onToggle: () => void;
  actions?: ReactNode;
}) {
  const panelsT = useTranslations("panels");
  const statusLabel =
    change.status === "deleted"
      ? panelsT("removed")
      : change.status === "renamed"
        ? panelsT("renamed")
        : change.status === "untracked"
          ? panelsT("newFile")
          : null;
  const hasAddedLines = typeof change.addedLines === "number";
  const hasRemovedLines = typeof change.removedLines === "number";

  return (
    <div
      className={cn(
        "relative flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left",
        expanded
          ? "sticky top-0 z-30 border-b border-surface-200 dark:border-surface-700 bg-background"
          : "hover:bg-surface-100 dark:hover:bg-surface-900",
      )}
    >
      <button
        aria-label={
          expanded ? panelsT("collapseFileDiff") : panelsT("expandFileDiff")
        }
        aria-expanded={expanded}
        className="absolute inset-0 z-0 rounded-none focus-visible:outline-2 focus-visible:outline-surface-400 focus-visible:-outline-offset-2 dark:focus-visible:outline-surface-500"
        onClick={onToggle}
        title={
          expanded ? panelsT("collapseFileDiff") : panelsT("expandFileDiff")
        }
        type="button"
      />

      <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 items-center gap-2">
        <MaterialFileIcon className="size-4 shrink-0" path={change.path} />
        <span className="min-w-0 truncate font-mono text-xs">
          {change.path}
        </span>
        {statusLabel ? (
          <span
            className={cn(
              "shrink-0 font-medium font-sans",
              CHANGE_STATUS_LABEL_CLASSNAMES[change.status] ??
                "text-muted-foreground",
            )}
          >
            {statusLabel}
          </span>
        ) : null}
      </div>

      <div className="pointer-events-none relative z-10 ml-auto flex shrink-0 items-center gap-2 font-mono text-sm tabular-nums">
        {actions}
        {hasAddedLines ? (
          <span className="font-medium text-emerald-600">
            {formatChangeCount(change.addedLines, "+")}
          </span>
        ) : null}
        {hasRemovedLines ? (
          <span className="font-medium text-rose-600">
            {formatChangeCount(change.removedLines, "-")}
          </span>
        ) : null}
        <span className="flex size-7 items-center justify-center text-muted-foreground">
          {expanded ? (
            <ChevronDown className="size-4 shrink-0" />
          ) : (
            <ChevronRight className="size-4 shrink-0" />
          )}
        </span>
      </div>
    </div>
  );
}
