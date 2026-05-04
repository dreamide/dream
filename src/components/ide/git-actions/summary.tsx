import type {
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
} from "@/types/ide";
import {
  formatDelta,
  formatFileCount,
  getChangesAddedLines,
  getChangesRemovedLines,
  getStatusAddedLines,
  getStatusFileCount,
  getStatusRemovedLines,
} from "./utils";

export const GitDeltaSummary = ({
  showFileCount = true,
  status,
}: {
  showFileCount?: boolean;
  status: ProjectGitStatusResponse | null;
}) => (
  <div className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
    {showFileCount ? (
      <span className="text-muted-foreground">
        {formatFileCount(getStatusFileCount(status))}
      </span>
    ) : null}
    <span className="font-medium text-emerald-500">
      {formatDelta(getStatusAddedLines(status), "+")}
    </span>
    <span className="font-medium text-rose-500">
      {formatDelta(getStatusRemovedLines(status), "-")}
    </span>
  </div>
);

export const GitChangesDeltaSummary = ({
  changes,
  showFileCount = true,
}: {
  changes: ProjectGitStatusEntry[];
  showFileCount?: boolean;
}) => (
  <div className="flex shrink-0 items-center gap-2 font-mono text-xs tabular-nums">
    {showFileCount ? (
      <span className="text-muted-foreground">
        {formatFileCount(changes.length)}
      </span>
    ) : null}
    <span className="font-medium text-emerald-500">
      {formatDelta(getChangesAddedLines(changes), "+")}
    </span>
    <span className="font-medium text-rose-500">
      {formatDelta(getChangesRemovedLines(changes), "-")}
    </span>
  </div>
);

export const GitMenuDeltaSummary = ({
  status,
}: {
  status: ProjectGitStatusResponse | null;
}) =>
  status && getStatusFileCount(status) > 0 ? (
    <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      <span className="font-medium !text-emerald-500 group-focus/dropdown-menu-item:!text-emerald-500">
        {formatDelta(getStatusAddedLines(status), "+")}
      </span>
      <span className="font-medium !text-rose-500 group-focus/dropdown-menu-item:!text-rose-500">
        {formatDelta(getStatusRemovedLines(status), "-")}
      </span>
    </span>
  ) : null;
