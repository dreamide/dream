import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  FileIcon,
  GitCompareArrows,
  RefreshCw,
  Rows3,
} from "lucide-react";
import { useTheme } from "next-themes";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { cn } from "@/lib/utils";
import type {
  ProjectGitChangeStatus,
  ProjectGitDiffResponse,
  ProjectGitStatusEntry,
} from "@/types/ide";
import { AppShellPlaceholder } from "./ide-helpers";
import { useIdeStore } from "./ide-store";

type DiffViewMode = "unified" | "split";

const CHANGE_STATUS_ICON_CLASSNAMES: Record<ProjectGitChangeStatus, string> = {
  added: "text-emerald-600",
  copied: "text-sky-600",
  deleted: "text-rose-600",
  modified: "text-amber-600",
  renamed: "text-violet-600",
  untracked: "text-emerald-600",
};

const CHANGE_STATUS_LABELS: Partial<Record<ProjectGitChangeStatus, string>> = {
  deleted: "Removed",
  renamed: "Renamed",
  untracked: "New",
};

const CHANGE_STATUS_LABEL_CLASSNAMES: Partial<
  Record<ProjectGitChangeStatus, string>
> = {
  deleted:
    "rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold leading-4 text-rose-600 ring-1 ring-rose-200 dark:bg-rose-950/35 dark:text-rose-300 dark:ring-rose-900/60",
  untracked:
    "rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold leading-4 text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950/35 dark:text-emerald-300 dark:ring-emerald-900/60",
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

const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

type PierreDiffOptions = NonNullable<FileDiffProps<undefined>["options"]>;

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
  const { resolvedTheme } = useTheme();
  const diffOptions = useMemo<PierreDiffOptions>(
    () => ({
      diffIndicators: "bars",
      diffStyle: mode,
      disableFileHeader: true,
      hunkSeparators: "line-info",
      lineDiffType: "none",
      theme: {
        dark: "github-dark",
        light: "github-light",
      },
      themeType: resolvedTheme === "dark" ? "dark" : "light",
    }),
    [mode, resolvedTheme],
  );

  if (diffLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-4 text-muted-foreground text-sm">
        <Spinner className="size-4" />
        <span>Loading diff…</span>
      </div>
    );
  }

  if (diffError) {
    return (
      <div className="px-4 py-4">
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm">
          {diffError}
        </div>
      </div>
    );
  }

  if (!diff) {
    return null;
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
    <div className="border-t border-foreground/10 bg-background">
      {change.previousPath ? (
        <div className="border-b border-foreground/10 px-4 py-2 text-muted-foreground text-xs">
          {`${change.previousPath} -> ${change.path}`}
        </div>
      ) : null}
      <div className="overflow-x-auto text-xs">
        <DiffEmptyState diff={diff.diff} />
        {diff.diff.trim().length > 0 ? (
          showAddedFileContents && addedFileContents !== null ? (
            <CodeBlock
              className="dream-diff-viewer w-full"
              code={addedFileContents}
              language={inferDiffPreviewLanguage(change.path)}
              style={{ contentVisibility: "visible" }}
            >
              <CodeBlockHeader className="shrink-0 border-0 bg-transparent px-3 py-2">
                <CodeBlockTitle>
                  <FileIcon size={14} />
                  <CodeBlockFilename>{change.path}</CodeBlockFilename>
                </CodeBlockTitle>
                <CodeBlockActions>
                  <CodeBlockCopyButton />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          ) : diff.parsedDiff ? (
            <FileDiff
              className="dream-diff-viewer min-w-[720px]"
              fileDiff={diff.parsedDiff}
              options={diffOptions}
            />
          ) : (
            <pre className="dream-diff-viewer w-full overflow-x-auto whitespace-pre-wrap rounded-md border bg-muted/20 p-4 font-mono text-xs">
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

const ChangesRow = ({
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
    <div className="border-b border-foreground/10 bg-background">
      <button
        className={cn(
          "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
          expanded
            ? "sticky top-0 z-20 border-b border-foreground/10 bg-background"
            : "hover:bg-muted/30",
        )}
        onClick={onToggle}
        type="button"
      >
        {expanded ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}

        <FileIcon
          className={cn(
            "size-4 shrink-0",
            CHANGE_STATUS_ICON_CLASSNAMES[change.status],
          )}
        />

        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs">{change.path}</div>
        </div>

        <div className="ml-auto flex items-center gap-3 font-mono text-sm tabular-nums">
          {statusLabel ? (
            <span
              className={cn(
                "font-medium font-sans",
                CHANGE_STATUS_LABEL_CLASSNAMES[change.status] ??
                  "text-muted-foreground",
              )}
            >
              {statusLabel}
            </span>
          ) : null}
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

const getExpandedPaths = (
  expandedPathsByProject: Record<string, string[]>,
  projectId: string | null,
) => {
  if (!projectId) {
    return [];
  }

  return expandedPathsByProject[projectId] ?? [];
};

const ChangesPanelImpl = () => {
  const activeProject = useIdeStore((s) => s.getActiveProject());
  const diffLoadQueueRef = useRef<string[]>([]);
  const diffLoadQueuedPathsRef = useRef(new Set<string>());
  const diffLoadProcessingRef = useRef(false);
  const queuedProjectIdRef = useRef<string | null>(null);

  const [expandedPathsByProject, setExpandedPathsByProject] = useState<
    Record<string, string[]>
  >({});
  const [diffsByProject, setDiffsByProject] = useState<
    Record<string, Record<string, ProjectGitDiffResponse>>
  >({});
  const [diffViewModeByProject, setDiffViewModeByProject] = useState<
    Record<string, DiffViewMode>
  >({});
  const [diffErrorsByProject, setDiffErrorsByProject] = useState<
    Record<string, Record<string, string>>
  >({});
  const [diffLoadingByProject, setDiffLoadingByProject] = useState<
    Record<string, Record<string, boolean>>
  >({});

  const projectId = activeProject?.id ?? null;
  const projectPath = activeProject?.path ?? null;
  const gitRefreshKey = useIdeStore((s) =>
    projectId ? (s.projectGitRefreshKeys[projectId] ?? 0) : 0,
  );
  const {
    changes,
    error: statusError,
    isRepo,
    loading: statusLoading,
    refresh: refreshStatus,
  } = useProjectGitStatus(projectPath, gitRefreshKey);

  const expandedPaths = getExpandedPaths(expandedPathsByProject, projectId);
  const expandedPathSet = useMemo(
    () => new Set(expandedPaths),
    [expandedPaths],
  );
  const changesByPath = useMemo(
    () => new Map(changes.map((change) => [change.path, change])),
    [changes],
  );
  const diffViewMode = projectId
    ? (diffViewModeByProject[projectId] ?? "unified")
    : "unified";
  const projectDiffs = projectId ? (diffsByProject[projectId] ?? {}) : {};
  const projectDiffErrors = projectId
    ? (diffErrorsByProject[projectId] ?? {})
    : {};
  const projectDiffLoading = projectId
    ? (diffLoadingByProject[projectId] ?? {})
    : {};
  const allExpanded =
    changes.length > 0 &&
    changes.every((change) => expandedPathSet.has(change.path));

  useEffect(() => {
    queuedProjectIdRef.current = projectId;
    diffLoadQueueRef.current = [];
    diffLoadQueuedPathsRef.current.clear();
    diffLoadProcessingRef.current = false;
  }, [projectId]);

  useEffect(() => {
    void gitRefreshKey;
    if (!projectId) {
      return;
    }

    diffLoadQueueRef.current = [];
    diffLoadQueuedPathsRef.current.clear();
    diffLoadProcessingRef.current = false;
    setExpandedPathsByProject((current) => ({
      ...current,
      [projectId]: [],
    }));
    setDiffsByProject((current) => ({
      ...current,
      [projectId]: {},
    }));
    setDiffErrorsByProject((current) => ({
      ...current,
      [projectId]: {},
    }));
    setDiffLoadingByProject((current) => ({
      ...current,
      [projectId]: {},
    }));
  }, [gitRefreshKey, projectId]);

  const processQueuedDiffLoads = useCallback(async () => {
    if (
      diffLoadProcessingRef.current ||
      !projectId ||
      !projectPath ||
      diffLoadQueueRef.current.length === 0
    ) {
      return;
    }

    const nextFilePath = diffLoadQueueRef.current[0];
    if (!nextFilePath) {
      return;
    }

    diffLoadProcessingRef.current = true;

    try {
      const change = changesByPath.get(nextFilePath);
      if (!change) {
        throw new Error("File does not have Git changes.");
      }

      const response = await fetch("/api/project-git-diff", {
        body: JSON.stringify({
          filePath: nextFilePath,
          previousPath: change.previousPath,
          projectPath,
          status: change.status,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await readResponseText(response));
      }

      const payload = (await response.json()) as ProjectGitDiffResponse;
      if (queuedProjectIdRef.current !== projectId) {
        return;
      }

      setDiffsByProject((current) => ({
        ...current,
        [projectId]: {
          ...(current[projectId] ?? {}),
          [payload.filePath]: payload,
        },
      }));
      setDiffErrorsByProject((current) => {
        const nextProjectErrors = { ...(current[projectId] ?? {}) };
        delete nextProjectErrors[nextFilePath];

        return {
          ...current,
          [projectId]: nextProjectErrors,
        };
      });
    } catch (error) {
      if (queuedProjectIdRef.current !== projectId) {
        return;
      }

      setDiffErrorsByProject((current) => ({
        ...current,
        [projectId]: {
          ...(current[projectId] ?? {}),
          [nextFilePath]:
            error instanceof Error
              ? error.message
              : "Failed to load the file diff.",
        },
      }));
    } finally {
      if (queuedProjectIdRef.current === projectId) {
        setDiffLoadingByProject((current) => ({
          ...current,
          [projectId]: {
            ...(current[projectId] ?? {}),
            [nextFilePath]: false,
          },
        }));
      }

      diffLoadQueueRef.current = diffLoadQueueRef.current.filter(
        (path) => path !== nextFilePath,
      );
      diffLoadQueuedPathsRef.current.delete(nextFilePath);
      diffLoadProcessingRef.current = false;

      if (
        queuedProjectIdRef.current === projectId &&
        diffLoadQueueRef.current.length > 0
      ) {
        void processQueuedDiffLoads();
      }
    }
  }, [changesByPath, projectId, projectPath]);

  const queueDiffLoad = useCallback(
    (filePath: string, priority = false) => {
      if (!projectId || !projectPath) {
        return;
      }

      if (
        projectDiffs[filePath] ||
        projectDiffErrors[filePath] ||
        projectDiffLoading[filePath] ||
        diffLoadQueuedPathsRef.current.has(filePath)
      ) {
        return;
      }

      diffLoadQueuedPathsRef.current.add(filePath);
      if (priority) {
        diffLoadQueueRef.current.unshift(filePath);
      } else {
        diffLoadQueueRef.current.push(filePath);
      }

      setDiffLoadingByProject((current) => ({
        ...current,
        [projectId]: {
          ...(current[projectId] ?? {}),
          [filePath]: true,
        },
      }));

      void processQueuedDiffLoads();
    },
    [
      processQueuedDiffLoads,
      projectDiffErrors,
      projectDiffLoading,
      projectDiffs,
      projectId,
      projectPath,
    ],
  );

  useEffect(() => {
    if (!projectId) {
      return;
    }

    for (const filePath of expandedPaths) {
      queueDiffLoad(filePath);
    }
  }, [expandedPaths, projectId, queueDiffLoad]);

  const handleRefresh = useCallback(() => {
    if (!projectId) {
      return;
    }

    diffLoadQueueRef.current = [];
    diffLoadQueuedPathsRef.current.clear();
    diffLoadProcessingRef.current = false;
    setDiffsByProject((current) => ({
      ...current,
      [projectId]: {},
    }));
    setDiffErrorsByProject((current) => ({
      ...current,
      [projectId]: {},
    }));
    setDiffLoadingByProject((current) => ({
      ...current,
      [projectId]: {},
    }));
    void refreshStatus();
  }, [projectId, refreshStatus]);

  const handleTogglePath = useCallback(
    (filePath: string) => {
      if (!projectId) {
        return;
      }

      let nextExpanded = false;
      setExpandedPathsByProject((current) => {
        const currentPaths = current[projectId] ?? [];
        const isExpanded = currentPaths.includes(filePath);
        nextExpanded = !isExpanded;

        return {
          ...current,
          [projectId]: isExpanded
            ? currentPaths.filter((path) => path !== filePath)
            : [...currentPaths, filePath],
        };
      });

      if (nextExpanded) {
        queueDiffLoad(filePath, true);
      }
    },
    [projectId, queueDiffLoad],
  );

  const handleToggleExpandAll = useCallback(() => {
    if (!projectId) {
      return;
    }

    if (allExpanded) {
      setExpandedPathsByProject((current) => ({
        ...current,
        [projectId]: [],
      }));
      return;
    }

    const nextPaths = changes.map((change) => change.path);
    setExpandedPathsByProject((current) => ({
      ...current,
      [projectId]: nextPaths,
    }));
    for (const filePath of nextPaths) {
      queueDiffLoad(filePath);
    }
  }, [allExpanded, changes, projectId, queueDiffLoad]);

  const handleSetDiffViewMode = useCallback(
    (nextMode: DiffViewMode) => {
      if (!projectId) {
        return;
      }

      setDiffViewModeByProject((current) => ({
        ...current,
        [projectId]: nextMode,
      }));
    },
    [projectId],
  );

  if (!activeProject) {
    return (
      <div className="flex h-full flex-col overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md">
        <div className="flex items-center gap-2 border-b border-foreground/10 bg-muted/50 px-3 py-2 text-sm font-medium">
          <GitCompareArrows className="size-4 text-muted-foreground" />
          <span>Changes</span>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <AppShellPlaceholder message="Add a project to inspect its Git changes." />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md">
      <div className="flex items-center gap-3 border-b border-foreground/10 bg-muted/50 px-3 py-2">
        <GitCompareArrows className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Changes</div>
        </div>

        <div className="flex overflow-hidden rounded-md border border-foreground/10 bg-muted/30 p-0.5">
          <Tooltip>
            <TooltipTrigger
              aria-label="Unified diff"
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors",
                diffViewMode === "unified"
                  ? "bg-background text-foreground shadow-sm"
                  : "hover:bg-muted/60 hover:text-foreground",
              )}
              onClick={() => handleSetDiffViewMode("unified")}
              type="button"
            >
              <Rows3 className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Unified diff</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              aria-label="Split diff"
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors",
                diffViewMode === "split"
                  ? "bg-background text-foreground shadow-sm"
                  : "hover:bg-muted/60 hover:text-foreground",
              )}
              onClick={() => handleSetDiffViewMode("split")}
              type="button"
            >
              <Columns2 className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Split diff</TooltipContent>
          </Tooltip>
        </div>

        <Button
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={handleToggleExpandAll}
          type="button"
          variant="outline"
        >
          {allExpanded ? "Collapse all" : "Expand all"}
        </Button>

        <Button
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={handleRefresh}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {statusLoading ? (
            <Spinner className="size-3.5 text-muted-foreground" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        {statusError ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm">
            {statusError}
          </div>
        ) : null}

        {!statusError && !statusLoading && !isRepo ? (
          <AppShellPlaceholder message="This project is not inside a Git repository." />
        ) : null}

        {!statusError && statusLoading && changes.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner className="size-4" />
              <span>Loading Git changes…</span>
            </div>
          </div>
        ) : null}

        {!statusError && !statusLoading && isRepo && changes.length === 0 ? (
          <AppShellPlaceholder message="Working tree is clean." />
        ) : null}

        {!statusError && changes.length > 0 ? (
          <div className="-mx-3 -mb-3">
            {changes.map((change) => (
              <ChangesRow
                change={change}
                diff={projectDiffs[change.path] ?? null}
                diffError={projectDiffErrors[change.path] ?? null}
                diffLoading={projectDiffLoading[change.path] ?? false}
                expanded={expandedPathSet.has(change.path)}
                key={change.path}
                mode={diffViewMode}
                onToggle={() => handleTogglePath(change.path)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const ChangesPanel = memo(ChangesPanelImpl);
ChangesPanel.displayName = "ChangesPanel";
