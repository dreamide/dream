import {
  Code,
  Columns2,
  ListChevronsUpDown,
  ListCollapse,
  RotateCw,
  Rows3,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { cn } from "@/lib/utils";
import type { ProjectGitDiffResponse } from "@/types/ide";
import { ChangesRow, type DiffViewMode, readResponseText } from "./changes";
import { AppShellPlaceholder } from "./ide-helpers";
import { useIdeStore } from "./ide-store";

export interface ChangesPanelProps {
  projectId?: string | null;
}

const getExpandedPaths = (
  expandedPathsByProject: Record<string, string[]>,
  projectId: string | null,
) => {
  if (!projectId) {
    return [];
  }

  return expandedPathsByProject[projectId] ?? [];
};

const ChangesPanelImpl = ({
  projectId: requestedProjectId,
}: ChangesPanelProps) => {
  const activeProject = useIdeStore((s) =>
    requestedProjectId
      ? (s.projects.find((project) => project.id === requestedProjectId) ??
        null)
      : s.getActiveProject(),
  );
  const diffLoadQueueRef = useRef<string[]>([]);
  const diffLoadQueuedPathsRef = useRef(new Set<string>());
  const diffLoadProcessingRef = useRef(false);
  const diffRefreshPendingByProjectRef = useRef<
    Record<string, { refreshKey: number; sawLoading: boolean }>
  >({});
  const previousGitRefreshKeyByProjectRef = useRef<Record<string, number>>({});
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
  const expandAllTitle = allExpanded ? "Collapse all" : "Expand all";
  const shouldDeferDiffLoads = useCallback(() => {
    if (!projectId) {
      return true;
    }

    const pending = diffRefreshPendingByProjectRef.current[projectId];
    return (
      !!pending &&
      pending.refreshKey === gitRefreshKey &&
      (statusLoading || !pending.sawLoading)
    );
  }, [gitRefreshKey, projectId, statusLoading]);

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

    const previousGitRefreshKey =
      previousGitRefreshKeyByProjectRef.current[projectId];
    previousGitRefreshKeyByProjectRef.current[projectId] = gitRefreshKey;
    if (
      previousGitRefreshKey !== undefined &&
      previousGitRefreshKey !== gitRefreshKey
    ) {
      diffRefreshPendingByProjectRef.current[projectId] = {
        refreshKey: gitRefreshKey,
        sawLoading: false,
      };
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

    const pending = diffRefreshPendingByProjectRef.current[projectId];
    if (pending?.refreshKey === gitRefreshKey) {
      if (statusLoading) {
        pending.sawLoading = true;
        return;
      }

      if (!pending.sawLoading) {
        return;
      }

      delete diffRefreshPendingByProjectRef.current[projectId];
    }

    if (statusLoading || shouldDeferDiffLoads()) {
      return;
    }

    for (const filePath of expandedPaths) {
      if (changesByPath.has(filePath)) {
        queueDiffLoad(filePath);
      }
    }
  }, [
    changesByPath,
    expandedPaths,
    gitRefreshKey,
    projectId,
    queueDiffLoad,
    shouldDeferDiffLoads,
    statusLoading,
  ]);

  useEffect(() => {
    if (!projectId || statusLoading || shouldDeferDiffLoads()) {
      return;
    }

    setExpandedPathsByProject((current) => {
      const currentPaths = current[projectId] ?? [];
      const nextPaths = currentPaths.filter((path) => changesByPath.has(path));
      if (nextPaths.length === currentPaths.length) {
        return current;
      }

      return {
        ...current,
        [projectId]: nextPaths,
      };
    });
  }, [changesByPath, projectId, shouldDeferDiffLoads, statusLoading]);

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

      if (nextExpanded && !shouldDeferDiffLoads()) {
        queueDiffLoad(filePath, true);
      }
    },
    [projectId, queueDiffLoad, shouldDeferDiffLoads],
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
    if (!shouldDeferDiffLoads()) {
      for (const filePath of nextPaths) {
        queueDiffLoad(filePath);
      }
    }
  }, [allExpanded, changes, projectId, queueDiffLoad, shouldDeferDiffLoads]);

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

  const handleRefreshChanges = useCallback(() => {
    if (!projectId) {
      return;
    }
    useIdeStore.getState().bumpProjectGitRefreshKey(projectId);
  }, [projectId]);

  if (!activeProject) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-foreground/10 bg-muted/50 px-3 py-2 text-sm font-medium">
          <Code className="size-4 text-muted-foreground" />
          <span>Changes</span>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <AppShellPlaceholder message="Add a project to inspect its Git changes." />
        </div>
      </div>
    );
  }

  return (
    <div className="changes-panel flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-foreground/10 bg-muted/50 px-3 py-2">
        <Code className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Changes</div>
        </div>

        <div className="flex overflow-hidden rounded-md border border-foreground/15 bg-background/70 p-0.5">
          <button
            aria-label="Unified diff"
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors",
              diffViewMode === "unified"
                ? "bg-muted text-foreground shadow-sm"
                : "hover:bg-muted/70 hover:text-foreground",
            )}
            onClick={() => handleSetDiffViewMode("unified")}
            title="Unified diff"
            type="button"
          >
            <Rows3 className="size-3.5" />
          </button>
          <button
            aria-label="Split diff"
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors",
              diffViewMode === "split"
                ? "bg-muted text-foreground shadow-sm"
                : "hover:bg-muted/70 hover:text-foreground",
            )}
            onClick={() => handleSetDiffViewMode("split")}
            title="Split diff"
            type="button"
          >
            <Columns2 className="size-3.5" />
          </button>
        </div>

        <Button
          aria-label={expandAllTitle}
          className="size-7 p-0"
          onClick={handleToggleExpandAll}
          title={expandAllTitle}
          type="button"
          variant="outline"
        >
          {allExpanded ? (
            <ListCollapse className="size-3.5" />
          ) : (
            <ListChevronsUpDown className="size-3.5" />
          )}
        </Button>

        <button
          aria-label="Refresh changes"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={handleRefreshChanges}
          title="Refresh changes"
          type="button"
        >
          <RotateCw className="size-3.5" />
        </button>
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
