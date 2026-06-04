import { ChevronDown, ChevronRight } from "lucide-react";
import type { BundledLanguage } from "shiki";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
} from "@/components/ai-elements/code-block";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type {
  ProjectGitChangeStatus,
  ProjectGitDiffResponse,
  ProjectGitStatusEntry,
} from "@/types/ide";
import { IdeDiffViewer } from "../diff-viewer";
import { MaterialFileIcon } from "../material-file-icon";

export type DiffViewMode = "unified" | "split";

export interface ChangesPanelProps {
  active?: boolean;
  projectId?: string | null;
}

const CHANGE_STATUS_LABELS: Partial<Record<ProjectGitChangeStatus, string>> = {
  deleted: "Removed",
  renamed: "Renamed",
  untracked: "New",
};

const CHANGE_STATUS_LABEL_CLASSNAMES: Partial<
  Record<ProjectGitChangeStatus, string>
> = {
  deleted:
    "rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold leading-4 text-rose-600 ring-1 ring-rose-200 dark:bg-destructive-surface dark:text-rose-300 dark:ring-destructive-border-strong",
  untracked:
    "rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold leading-4 text-emerald-700 ring-1 ring-emerald-200 dark:bg-success-surface dark:text-emerald-300 dark:ring-success-border",
};

const DiffEmptyState = ({ diff }: { diff: string }) => {
  if (diff.trim().length > 0) {
    return null;
  }

  return (
    <pre className="p-4 font-mono text-xs leading-5 whitespace-pre-wrap">
      No diff output available.
    </pre>
  );
};

const inferDiffPreviewLanguage = (filePath: string): BundledLanguage => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  const languages: Record<string, BundledLanguage> = {
    c: "c",
    cpp: "cpp",
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    txt: "log",
    yml: "yaml",
    yaml: "yaml",
  };

  return languages[extension] ?? "log";
};

export const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

const ExpandedDiffBody = ({
  change,
  diff,
  diffError,
  diffLoading,
  mode,
}: {
  change: ProjectGitStatusEntry;
  diff: ProjectGitDiffResponse | null;
  diffError: string | null;
  diffLoading: boolean;
  mode: DiffViewMode;
}) => {
  if (diffLoading && !diff) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-muted-foreground text-sm">
        <Spinner className="size-4" />
      </div>
    );
  }

  if (diffError) {
    return (
      <div className="px-4 py-4">
        <div className="rounded-md border border-destructive-border bg-destructive-surface-muted px-3 py-2 text-destructive text-sm">
          {diffError}
        </div>
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-muted-foreground text-sm">
        <Spinner className="size-4" />
      </div>
    );
  }

  const showAddedFileContents =
    !!diff.parsedDiff &&
    diff.parsedDiff.type === "new" &&
    diff.parsedDiff.deletionLines.length === 0 &&
    (change.status === "untracked" || change.status === "added");
  const addedFileContents = showAddedFileContents
    ? (diff.parsedDiff?.additionLines.join("") ?? "")
    : null;

  return (
    <div className="bg-surface-50 dark:bg-surface-900">
      {change.previousPath ? (
        <div className="border-b border-surface-200 dark:border-surface-800 px-4 py-2 text-muted-foreground text-xs">
          {`${change.previousPath} -> ${change.path}`}
        </div>
      ) : null}
      <div className="overflow-x-auto text-xs">
        <DiffEmptyState diff={diff.diff} />
        {diff.diff.trim().length > 0 ? (
          showAddedFileContents && addedFileContents !== null ? (
            <CodeBlock
              className="dream-diff-viewer w-full rounded-none border-0"
              code={addedFileContents}
              language={inferDiffPreviewLanguage(change.path)}
              showLineNumbers
              startingLineNumber={1}
              style={{ contentVisibility: "visible" }}
            >
              <CodeBlockHeader className="flex shrink-0 justify-end border-0 bg-transparent px-3 py-2">
                <CodeBlockActions>
                  <CodeBlockCopyButton />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          ) : diff.parsedDiff ? (
            <IdeDiffViewer
              className="min-w-[720px]"
              diffStyle={mode}
              fileDiff={diff.parsedDiff}
            />
          ) : (
            <pre className="dream-diff-viewer w-full overflow-x-auto whitespace-pre-wrap bg-surface-100 dark:bg-surface-900 p-4 font-mono text-xs">
              {diff.diff}
            </pre>
          )
        ) : null}
      </div>
    </div>
  );
};

const formatChangeCount = (value: number, prefix: "+" | "-") =>
  `${prefix}${value}`;

export const ChangesRow = ({
  change,
  diff,
  diffError,
  diffLoading,
  expanded,
  mode,
  onToggle,
}: {
  change: ProjectGitStatusEntry;
  diff: ProjectGitDiffResponse | null;
  diffError: string | null;
  diffLoading: boolean;
  expanded: boolean;
  mode: DiffViewMode;
  onToggle: () => void;
}) => {
  const statusLabel = CHANGE_STATUS_LABELS[change.status] ?? null;
  const hasAddedLines = typeof change.addedLines === "number";
  const hasRemovedLines = typeof change.removedLines === "number";

  return (
    <div className="border-b border-surface-200 dark:border-surface-700 bg-background">
      <button
        className={cn(
          "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
          expanded
            ? "sticky top-0 z-30 border-b border-surface-200 dark:border-surface-700 bg-background shadow-sm"
            : "hover:bg-surface-100 dark:hover:bg-surface-900",
        )}
        onClick={onToggle}
        type="button"
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
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
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3 font-mono text-sm tabular-nums">
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
          {expanded ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded ? (
        <ExpandedDiffBody
          change={change}
          diff={diff}
          diffError={diffError}
          diffLoading={diffLoading}
          mode={mode}
        />
      ) : null}
    </div>
  );
};
