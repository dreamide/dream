import {
  Columns2,
  FileIcon,
  GitCompareArrows,
  RefreshCw,
  Rows3,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName,
} from "@/components/ai-elements/file-tree";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { AppShellPlaceholder, PanelResizeHandle } from "./ide-helpers";
import { useIdeStore } from "./ide-store";

const FILE_TREE_MIN_WIDTH_PX = 250;
const FILE_TREE_MAX_WIDTH_RATIO = 0.5;
const INITIAL_DIFF_PREFETCH_COUNT = 4;

type DiffViewMode = "unified" | "split";

interface FileTreeNode {
  name: string;
  path: string;
  children: Map<string, FileTreeNode>;
  isFile: boolean;
}

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

const buildFileTree = (
  paths: string[],
): { root: FileTreeNode; defaultExpanded: Set<string> } => {
  const root: FileTreeNode = {
    children: new Map(),
    isFile: false,
    name: "",
    path: "",
  };

  for (const filePath of paths) {
    const parts = filePath.split(/[\\/]/).filter(Boolean);
    let current = root;

    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      const currentPath = parts.slice(0, index + 1).join("/");
      const isLast = index === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          children: new Map(),
          isFile: isLast,
          name: part,
          path: currentPath,
        });
      }

      const nextNode = current.children.get(part);
      if (!nextNode) {
        continue;
      }

      current = nextNode;
    }
  }

  const defaultExpanded = new Set<string>();
  for (const child of root.children.values()) {
    if (!child.isFile) {
      defaultExpanded.add(child.path);
    }
  }

  return { defaultExpanded, root };
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
      currentHunk = {
        header: line,
        lines: [],
      };
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

const getUnifiedDiffLineTone = (kind: ParsedDiffLine["kind"]) => {
  if (kind === "add") {
    return "bg-emerald-500/10";
  }

  if (kind === "remove") {
    return "bg-rose-500/10";
  }

  if (kind === "meta") {
    return "bg-muted/25";
  }

  return "bg-background";
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
      <div className="border-b border-foreground/5 bg-muted/25 px-3 py-1 font-mono text-[11px] text-muted-foreground italic">
        {line.text}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid grid-cols-[3rem_3rem_1.5rem_minmax(0,1fr)] border-b border-foreground/5 font-mono text-xs leading-5",
        getUnifiedDiffLineTone(line.kind),
      )}
    >
      <div className="border-r border-foreground/10 px-2 py-1 text-right text-[11px] text-muted-foreground/80 tabular-nums">
        {line.oldNumber ?? ""}
      </div>
      <div className="border-r border-foreground/10 px-2 py-1 text-right text-[11px] text-muted-foreground/80 tabular-nums">
        {line.newNumber ?? ""}
      </div>
      <div className="border-r border-foreground/10 px-2 py-1 text-center text-muted-foreground">
        {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : ""}
      </div>
      <pre className="overflow-x-auto px-3 py-1 whitespace-pre">
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
          header?: string;
        }> = [
          {
            header: hunk.header,
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

const getDiffSectionId = (filePath: string) =>
  `changes-diff-${filePath.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}`;

const DiffSection = ({
  diff,
  filePath,
  mode,
}: {
  diff: ProjectGitDiffResponse;
  filePath: string;
  mode: DiffViewMode;
}) => {
  return (
    <section
      className="scroll-mt-3 border-b border-foreground/10 last:border-b-0"
      id={getDiffSectionId(filePath)}
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-foreground/10 bg-background/95 px-4 py-2 backdrop-blur-sm">
        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 truncate font-medium text-sm">{filePath}</div>
      </div>
      <div className="overflow-x-auto">
        {mode === "split" ? (
          <SplitDiffView diff={diff.diff} />
        ) : (
          <UnifiedDiffView diff={diff.diff} />
        )}
      </div>
    </section>
  );
};

const DiffSectionSkeleton = ({ filePath }: { filePath: string }) => {
  return (
    <section
      className="scroll-mt-3 border-b border-foreground/10 last:border-b-0"
      id={getDiffSectionId(filePath)}
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-foreground/10 bg-background/95 px-4 py-2 backdrop-blur-sm">
        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 truncate font-medium text-sm">{filePath}</div>
      </div>
      <div className="flex items-center gap-2 px-4 py-6 text-muted-foreground text-sm">
        <Spinner className="size-4" />
        <span>Loading diff…</span>
      </div>
    </section>
  );
};

const DiffSectionError = ({
  error,
  filePath,
}: {
  error: string;
  filePath: string;
}) => {
  return (
    <section
      className="scroll-mt-3 border-b border-foreground/10 last:border-b-0"
      id={getDiffSectionId(filePath)}
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-foreground/10 bg-background/95 px-4 py-2 backdrop-blur-sm">
        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 truncate font-medium text-sm">{filePath}</div>
      </div>
      <div className="p-4">
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm">
          {error}
        </div>
      </div>
    </section>
  );
};

const LazyDiffSection = ({
  diff,
  diffError,
  diffLoading,
  filePath,
  mode,
  onRegisterRef,
  onVisible,
}: {
  diff: ProjectGitDiffResponse | null;
  diffError: string | null;
  diffLoading: boolean;
  filePath: string;
  mode: DiffViewMode;
  onRegisterRef: (filePath: string, node: HTMLDivElement | null) => void;
  onVisible: (filePath: string) => void;
}) => {
  const sectionRef = useRef<HTMLDivElement | null>(null);

  const handleSectionRef = useCallback(
    (node: HTMLDivElement | null) => {
      sectionRef.current = node;
      onRegisterRef(filePath, node);
    },
    [filePath, onRegisterRef],
  );

  useEffect(() => {
    if (diff || diffError || diffLoading) {
      return;
    }

    const node = sectionRef.current;
    if (!node) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const isVisible = entries.some(
          (entry) => entry.isIntersecting || entry.intersectionRatio > 0,
        );
        if (!isVisible) {
          return;
        }

        onVisible(filePath);
        observer.disconnect();
      },
      { rootMargin: "500px 0px" },
    );

    observer.observe(node);

    return () => {
      observer.disconnect();
    };
  }, [diff, diffError, diffLoading, filePath, onVisible]);

  return (
    <div ref={handleSectionRef}>
      {diff ? (
        <DiffSection diff={diff} filePath={filePath} mode={mode} />
      ) : diffError ? (
        <DiffSectionError error={diffError} filePath={filePath} />
      ) : (
        <DiffSectionSkeleton filePath={filePath} />
      )}
    </div>
  );
};

const FileTreeNodeView = ({
  changeByPath,
  node,
}: {
  changeByPath: Map<string, ProjectGitStatusEntry>;
  node: FileTreeNode;
}) => {
  const sortedChildren = [...node.children.values()].sort((left, right) => {
    if (left.isFile !== right.isFile) {
      return left.isFile ? 1 : -1;
    }

    return left.name.localeCompare(right.name);
  });

  if (node.isFile) {
    const change = changeByPath.get(node.path);
    const status = change?.status ?? "modified";

    return (
      <FileTreeFile name={node.name} path={node.path}>
        <span className="size-4" />
        <FileTreeIcon>
          <FileIcon
            className={cn("size-4", CHANGE_STATUS_ICON_CLASSNAMES[status])}
          />
        </FileTreeIcon>
        <FileTreeName>{node.name}</FileTreeName>
      </FileTreeFile>
    );
  }

  return (
    <FileTreeFolder name={node.name} path={node.path}>
      {sortedChildren.map((child) => (
        <FileTreeNodeView
          changeByPath={changeByPath}
          key={child.path}
          node={child}
        />
      ))}
    </FileTreeFolder>
  );
};

const ChangesPanelImpl = () => {
  const activeProject = useIdeStore((s) => s.getActiveProject());
  const diffSectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const diffLoadQueueRef = useRef<string[]>([]);
  const diffLoadQueuedPathsRef = useRef(new Set<string>());
  const diffLoadProcessingRef = useRef(false);
  const queuedProjectIdRef = useRef<string | null>(null);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const treePaneRef = useRef<HTMLDivElement | null>(null);
  const treeWidthRef = useRef<number | null>(null);

  const [selectedFileByProject, setSelectedFileByProject] = useState<
    Record<string, string | null>
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
  const selectedFilePath = projectId
    ? (selectedFileByProject[projectId] ?? null)
    : null;
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

  const changeByPath = useMemo(() => {
    return new Map(changes.map((change) => [change.path, change]));
  }, [changes]);

  const { defaultExpanded, root } = useMemo(() => {
    if (changes.length === 0) {
      return { defaultExpanded: new Set<string>(), root: null };
    }

    return buildFileTree(changes.map((change) => change.path));
  }, [changes]);

  const sortedChildren = useMemo(() => {
    if (!root) {
      return [];
    }

    return [...root.children.values()].sort((left, right) => {
      if (left.isFile !== right.isFile) {
        return left.isFile ? 1 : -1;
      }

      return left.name.localeCompare(right.name);
    });
  }, [root]);

  useEffect(() => {
    if (!projectId) {
      return;
    }

    setSelectedFileByProject((current) => {
      const existingSelection = current[projectId] ?? null;
      if (
        existingSelection &&
        changes.some((change) => change.path === existingSelection)
      ) {
        return current;
      }

      return {
        ...current,
        [projectId]: changes[0]?.path ?? null,
      };
    });
  }, [changes, projectId]);

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
    (filePath: string) => {
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
      diffLoadQueueRef.current.push(filePath);

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
    if (!projectId || !projectPath || changes.length === 0) {
      return;
    }

    const initialPaths = [
      ...(selectedFilePath ? [selectedFilePath] : []),
      ...changes
        .slice(0, INITIAL_DIFF_PREFETCH_COUNT)
        .map((change) => change.path),
    ];

    for (const filePath of new Set(initialPaths)) {
      queueDiffLoad(filePath);
    }
  }, [changes, projectId, projectPath, queueDiffLoad, selectedFilePath]);

  const handleTreeResizeStart = useCallback(() => {
    treeWidthRef.current =
      treePaneRef.current?.getBoundingClientRect().width ??
      FILE_TREE_MIN_WIDTH_PX;
  }, []);

  const handleTreeResize = useCallback((deltaX: number) => {
    const containerWidth =
      splitContainerRef.current?.getBoundingClientRect().width ?? 0;
    const maxWidth = Math.max(
      FILE_TREE_MIN_WIDTH_PX,
      containerWidth * FILE_TREE_MAX_WIDTH_RATIO,
    );
    const nextWidth = Math.min(
      maxWidth,
      Math.max(
        FILE_TREE_MIN_WIDTH_PX,
        (treeWidthRef.current ?? FILE_TREE_MIN_WIDTH_PX) + deltaX,
      ),
    );

    treeWidthRef.current = nextWidth;
    if (treePaneRef.current) {
      treePaneRef.current.style.width = `${nextWidth}px`;
    }
  }, []);

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

  const registerDiffSectionRef = useCallback(
    (filePath: string, node: HTMLDivElement | null) => {
      diffSectionRefs.current[filePath] = node;
    },
    [],
  );

  const handleSelectFile = useCallback(
    (filePath: string) => {
      if (!projectId || !changeByPath.has(filePath)) {
        return;
      }

      setSelectedFileByProject((current) => ({
        ...current,
        [projectId]: filePath,
      }));
      queueDiffLoad(filePath);

      const section = diffSectionRefs.current[filePath];
      if (section) {
        section.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    },
    [changeByPath, projectId, queueDiffLoad],
  );

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
          <span></span>
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

      <div ref={splitContainerRef} className="flex min-h-0 flex-1">
        <div
          ref={treePaneRef}
          className="shrink-0 overflow-hidden"
          style={{
            width: `${treeWidthRef.current ?? FILE_TREE_MIN_WIDTH_PX}px`,
            minWidth: FILE_TREE_MIN_WIDTH_PX,
            maxWidth: `${FILE_TREE_MAX_WIDTH_RATIO * 100}%`,
          }}
        >
          <div className="h-full border-r border-foreground/10 bg-muted/20">
            <ScrollArea className="h-full">
              <div className="p-3">
                {statusError ? (
                  <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-xs">
                    {statusError}
                  </div>
                ) : null}

                {!statusError && !statusLoading && !isRepo ? (
                  <div className="text-muted-foreground text-sm">
                    This project is not inside a Git repository.
                  </div>
                ) : null}

                {!statusError && statusLoading && changes.length === 0 ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Spinner className="size-4" />
                    <span>Loading Git changes…</span>
                  </div>
                ) : null}

                {!statusError &&
                !statusLoading &&
                isRepo &&
                changes.length === 0 ? (
                  <div className="text-muted-foreground text-sm">
                    Working tree is clean.
                  </div>
                ) : null}

                {root ? (
                  <FileTree
                    className="border-0 bg-transparent p-0 text-xs shadow-none"
                    defaultExpanded={defaultExpanded}
                    onSelect={handleSelectFile}
                    selectedPath={selectedFilePath ?? undefined}
                  >
                    {sortedChildren.map((child) => (
                      <FileTreeNodeView
                        changeByPath={changeByPath}
                        key={child.path}
                        node={child}
                      />
                    ))}
                  </FileTree>
                ) : null}
              </div>
            </ScrollArea>
          </div>
        </div>

        <PanelResizeHandle
          side="right"
          onResize={handleTreeResize}
          onResizeStart={handleTreeResizeStart}
        />

        <div className="min-w-0 flex-1 overflow-hidden">
          {!changes.length && !statusLoading && !statusError ? (
            <div className="h-full p-3">
              <AppShellPlaceholder message="No changed files to inspect." />
            </div>
          ) : (
            <div className="h-full overflow-auto">
              {changes.map((change) => {
                const diff = projectDiffs[change.path] ?? null;
                const diffError = projectDiffErrors[change.path] ?? null;
                const diffLoading = projectDiffLoading[change.path] ?? false;

                return (
                  <LazyDiffSection
                    diff={diff}
                    diffError={diffError}
                    diffLoading={diffLoading}
                    filePath={change.path}
                    key={change.path}
                    mode={diffViewMode}
                    onRegisterRef={registerDiffSectionRef}
                    onVisible={queueDiffLoad}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const ChangesPanel = memo(ChangesPanelImpl);
ChangesPanel.displayName = "ChangesPanel";
