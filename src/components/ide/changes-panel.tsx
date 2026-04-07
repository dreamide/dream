import {
  ChevronDown,
  ChevronRight,
  Columns2,
  FileIcon,
  GitCompareArrows,
  RefreshCw,
  Rows3,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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

interface ParsedDiffLine {
  kind: "context" | "add" | "remove" | "meta";
  newNumber: number | null;
  oldNumber: number | null;
  text: string;
}

interface ParsedDiffHunk {
  header: string;
  lines: ParsedDiffLine[];
}

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

const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

const parseHunkHeader = (line: string) => {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) {
    return null;
  }

  return {
    newStart: Number(match[3]),
    oldStart: Number(match[1]),
  };
};

const parseUnifiedDiff = (
  diff: string,
): { hunks: ParsedDiffHunk[]; metadata: string[] } => {
  const hunks: ParsedDiffHunk[] = [];
  const metadata: string[] = [];
  let currentHunk: ParsedDiffHunk | null = null;
  let oldNumber = 0;
  let newNumber = 0;

  for (const line of diff.split("\n")) {
    const hunkHeader = parseHunkHeader(line);
    if (hunkHeader) {
      currentHunk = { header: line, lines: [] };
      hunks.push(currentHunk);
      oldNumber = hunkHeader.oldStart;
      newNumber = hunkHeader.newStart;
      continue;
    }

    if (!currentHunk) {
      metadata.push(line);
      continue;
    }

    if (line.startsWith("\\ ")) {
      currentHunk.lines.push({
        kind: "meta",
        newNumber: null,
        oldNumber: null,
        text: line,
      });
      continue;
    }

    if (line.startsWith("+")) {
      currentHunk.lines.push({
        kind: "add",
        newNumber,
        oldNumber: null,
        text: line.slice(1),
      });
      newNumber += 1;
      continue;
    }

    if (line.startsWith("-")) {
      currentHunk.lines.push({
        kind: "remove",
        newNumber: null,
        oldNumber,
        text: line.slice(1),
      });
      oldNumber += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      currentHunk.lines.push({
        kind: "context",
        newNumber,
        oldNumber,
        text: line.slice(1),
      });
      oldNumber += 1;
      newNumber += 1;
      continue;
    }

    currentHunk.lines.push({
      kind: "meta",
      newNumber: null,
      oldNumber: null,
      text: line,
    });
  }

  return { hunks, metadata };
};

const DIFF_METADATA_PREFIXES = [
  "diff --git ",
  "index ",
  "--- ",
  "+++ ",
  "new file mode ",
  "deleted file mode ",
  "similarity index ",
  "rename from ",
  "rename to ",
];

const getDisplayMetadata = (metadata: string[]) => {
  return metadata.filter(
    (line) =>
      line.trim().length > 0 &&
      !DIFF_METADATA_PREFIXES.some((prefix) => line.startsWith(prefix)),
  );
};

const getParsedDiffLineKey = (line: ParsedDiffLine) => {
  return `${line.kind}-${line.oldNumber ?? "x"}-${line.newNumber ?? "y"}-${line.text}`;
};

const getDiffLineTone = (
  kind: ParsedDiffLine["kind"],
  side: "left" | "right",
) => {
  if (kind === "add") {
    return side === "right" ? "bg-emerald-500/10" : "bg-muted/15";
  }

  if (kind === "remove") {
    return side === "left" ? "bg-rose-500/10" : "bg-muted/15";
  }

  if (kind === "meta") {
    return "bg-muted/40 text-muted-foreground";
  }

  return "bg-background";
};

const getUnifiedDiffBorderTone = (kind: ParsedDiffLine["kind"]) => {
  if (kind === "add") {
    return "border-l-emerald-500";
  }

  if (kind === "remove") {
    return "border-l-rose-500";
  }

  return "border-l-transparent";
};

const getUnifiedDiffTextTone = (kind: ParsedDiffLine["kind"]) => {
  if (kind === "add") {
    return "text-emerald-700";
  }

  if (kind === "remove") {
    return "text-rose-700";
  }

  if (kind === "meta") {
    return "text-muted-foreground";
  }

  return "text-foreground";
};

const DiffFallbackView = ({ diff }: { diff: string }) => {
  const { metadata } = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const displayLines = getDisplayMetadata(metadata);

  return (
    <pre className="p-4 font-mono text-xs leading-5 whitespace-pre-wrap">
      {displayLines.join("\n") || "No diff output available."}
    </pre>
  );
};

const UnifiedDiffRow = ({ line }: { line: ParsedDiffLine }) => {
  if (line.kind === "meta") {
    return (
      <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] border-b border-foreground/5 border-l-2 border-l-transparent font-mono text-[11px] italic leading-5">
        <div className="border-r border-foreground/10 bg-muted/15 px-2 py-1 text-right text-muted-foreground/70 tabular-nums" />
        <div className="px-3 py-1 text-muted-foreground">{line.text}</div>
      </div>
    );
  }

  const lineNumber = line.newNumber ?? line.oldNumber ?? "";

  return (
    <div
      className={cn(
        "grid grid-cols-[3.25rem_minmax(0,1fr)] border-b border-foreground/5 border-l-2 font-mono text-xs leading-5",
        getUnifiedDiffBorderTone(line.kind),
      )}
    >
      <div className="border-r border-foreground/10 bg-muted/15 px-2 py-1 text-right text-[11px] text-muted-foreground/80 tabular-nums">
        {lineNumber}
      </div>
      <pre
        className={cn(
          "overflow-x-auto px-3 py-1 whitespace-pre",
          getUnifiedDiffTextTone(line.kind),
        )}
      >
        {line.text || " "}
      </pre>
    </div>
  );
};

const UnifiedDiffView = ({ diff }: { diff: string }) => {
  const { hunks } = useMemo(() => parseUnifiedDiff(diff), [diff]);

  if (hunks.length === 0) {
    return <DiffFallbackView diff={diff} />;
  }

  return (
    <div className="min-w-[760px]">
      {hunks.map((hunk, hunkIndex) => (
        <div key={`${hunk.header}-${hunk.lines.length}`}>
          {hunkIndex > 0 ? (
            <div className="h-3 border-y border-foreground/10 bg-muted/20" />
          ) : null}
          {hunk.lines.map((line) => (
            <UnifiedDiffRow key={getParsedDiffLineKey(line)} line={line} />
          ))}
        </div>
      ))}
    </div>
  );
};

const SplitDiffRow = ({
  left,
  right,
}: {
  left: ParsedDiffLine | null;
  right: ParsedDiffLine | null;
}) => {
  const renderCell = (
    line: ParsedDiffLine | null,
    side: "left" | "right",
    sibling: ParsedDiffLine | null,
  ) => {
    if (line?.kind === "meta") {
      return (
        <div className="border-r border-foreground/10 bg-muted/25 px-3 py-1 font-mono text-[11px] text-muted-foreground italic last:border-r-0">
          {line.text}
        </div>
      );
    }

    const lineNumber = side === "left" ? line?.oldNumber : line?.newNumber;
    const tone = getDiffLineTone(
      line?.kind ?? sibling?.kind ?? "context",
      side,
    );

    return (
      <div
        className={cn(
          "grid min-w-0 grid-cols-[3rem_minmax(0,1fr)] border-r border-foreground/10",
          tone,
          side === "right" && "border-r-0",
        )}
      >
        <div className="border-r border-foreground/10 px-2 py-1 text-right text-[11px] text-muted-foreground/80 tabular-nums">
          {lineNumber ?? ""}
        </div>
        <pre className="overflow-x-auto px-3 py-1 whitespace-pre">
          {line?.text ?? " "}
        </pre>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-2 border-b border-foreground/5 font-mono text-xs leading-5">
      {renderCell(left, "left", right)}
      {renderCell(right, "right", left)}
    </div>
  );
};

const SplitDiffView = ({ diff }: { diff: string }) => {
  const { hunks } = useMemo(() => parseUnifiedDiff(diff), [diff]);

  if (hunks.length === 0) {
    return <DiffFallbackView diff={diff} />;
  }

  return (
    <div className="min-w-[720px]">
      <div className="grid grid-cols-2 border-b border-foreground/10 bg-muted/25 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        <div className="border-r border-foreground/10 px-3 py-2">Original</div>
        <div className="px-3 py-2">Current</div>
      </div>

      {hunks.map((hunk, hunkIndex) => {
        const rows: Array<{
          kind: "hunk" | "line";
          key: string;
          left?: ParsedDiffLine | null;
          right?: ParsedDiffLine | null;
        }> = [
          {
            key: `${hunk.header}-header`,
            kind: "hunk",
          },
        ];

        for (let index = 0; index < hunk.lines.length; ) {
          const line = hunk.lines[index];

          if (line.kind === "context" || line.kind === "meta") {
            rows.push({
              key: `${hunk.header}-context-${index}`,
              kind: "line",
              left: line,
              right: line,
            });
            index += 1;
            continue;
          }

          const removed: ParsedDiffLine[] = [];
          const added: ParsedDiffLine[] = [];

          while (hunk.lines[index]?.kind === "remove") {
            removed.push(hunk.lines[index]);
            index += 1;
          }

          while (hunk.lines[index]?.kind === "add") {
            added.push(hunk.lines[index]);
            index += 1;
          }

          const pairCount = Math.max(removed.length, added.length);
          for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
            rows.push({
              key: `${hunk.header}-pair-${index}-${pairIndex}`,
              kind: "line",
              left: removed[pairIndex] ?? null,
              right: added[pairIndex] ?? null,
            });
          }
        }

        return (
          <div key={`${hunk.header}-${rows.length}`}>
            {hunkIndex > 0 ? (
              <div className="h-3 border-y border-foreground/10 bg-muted/20" />
            ) : null}
            {rows.map((row) =>
              row.kind === "hunk" ? (
                <div key={row.key} />
              ) : (
                <SplitDiffRow
                  key={row.key}
                  left={row.left ?? null}
                  right={row.right ?? null}
                />
              ),
            )}
          </div>
        );
      })}
    </div>
  );
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

  return (
    <div className="border-t border-foreground/10 bg-background">
      {change.previousPath ? (
        <div className="border-b border-foreground/10 px-4 py-2 text-muted-foreground text-xs">
          {`${change.previousPath} -> ${change.path}`}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        {mode === "split" ? (
          <SplitDiffView diff={diff.diff} />
        ) : (
          <UnifiedDiffView diff={diff.diff} />
        )}
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
    <div className="overflow-hidden rounded-lg border border-foreground/10 bg-background">
      <button
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
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
          <div className="truncate text-sm">{change.path}</div>
        </div>

        <div className="ml-auto flex items-center gap-3 text-sm tabular-nums">
          {statusLabel ? (
            <span
              className={cn(
                "font-medium",
                change.status === "deleted"
                  ? "text-rose-600"
                  : "text-muted-foreground",
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
  const {
    changes,
    error: statusError,
    isRepo,
    loading: statusLoading,
    refresh: refreshStatus,
  } = useProjectGitStatus(projectPath);

  const expandedPaths = getExpandedPaths(expandedPathsByProject, projectId);
  const expandedPathSet = useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const diffViewMode = projectId
    ? (diffViewModeByProject[projectId] ?? "unified")
    : "unified";
  const projectDiffs = projectId ? (diffsByProject[projectId] ?? {}) : {};
  const projectDiffErrors = projectId ? (diffErrorsByProject[projectId] ?? {}) : {};
  const projectDiffLoading = projectId ? (diffLoadingByProject[projectId] ?? {}) : {};
  const allExpanded =
    changes.length > 0 && changes.every((change) => expandedPathSet.has(change.path));

  useEffect(() => {
    queuedProjectIdRef.current = projectId;
    diffLoadQueueRef.current = [];
    diffLoadQueuedPathsRef.current.clear();
    diffLoadProcessingRef.current = false;
  }, [projectId]);

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
      const response = await fetch("/api/project-git-diff", {
        body: JSON.stringify({
          filePath: nextFilePath,
          projectPath,
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
  }, [projectId, projectPath]);

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
        <div className="flex items-center gap-2 border-b border-foreground/10 px-3 py-2 text-sm font-medium">
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
      <div className="flex items-center gap-3 border-b border-foreground/10 px-3 py-2">
        <GitCompareArrows className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Changes</div>
          <div className="truncate text-muted-foreground text-xs">
            {activeProject.path}
          </div>
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

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {statusError ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm">
            {statusError}
          </div>
        ) : null}

        {!statusError && !statusLoading && !isRepo ? (
          <AppShellPlaceholder message="This project is not inside a Git repository." />
        ) : null}

        {!statusError && statusLoading && changes.length === 0 ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            <span>Loading Git changes…</span>
          </div>
        ) : null}

        {!statusError && !statusLoading && isRepo && changes.length === 0 ? (
          <AppShellPlaceholder message="Working tree is clean." />
        ) : null}

        {!statusError && changes.length > 0 ? (
          <div className="space-y-2">
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
