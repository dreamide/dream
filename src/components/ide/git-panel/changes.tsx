import {
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Ellipsis,
  Rows3,
  Undo2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import type { ProjectGitStatusEntry } from "@/types/ide";
import { ChangesRow, type DiffViewMode } from "../changes";
import {
  changesViewReducer,
  EMPTY_CHANGES_VIEW,
  visibleChanges as listVisibleChanges,
} from "../changes/changes-view";
import { AppShellPlaceholder } from "../ide-helpers";
import { useIdeStore } from "../ide-store";
import { gitDiffResourceKey, useProjectResource } from "../project-resources";
import { WordWrapToggle } from "../word-wrap-toggle";
import { GitCommitBox } from "./commit-box";
import { GitPanelHeaderActions } from "./header-actions";

export interface GitChangesProps {
  /** Whether this tab is the one shown in a visible Git panel. */
  active: boolean;
  projectId: string;
}

type ChangesRowProps = Parameters<typeof ChangesRow>[0];

/**
 * One changed file, reading its diff (a project resource, shared with any
 * other reader of it) while it is expanded. `readDiff` says whether to read
 * it now: only while the tab shows a current status.
 */
const ChangeWithDiff = memo(
  ({
    change,
    expanded,
    hostId,
    projectPath,
    readDiff,
    ...rowProps
  }: Omit<ChangesRowProps, "diff" | "diffError" | "diffLoading"> & {
    hostId: string | undefined;
    readDiff: boolean;
  }) => {
    const panelsT = useTranslations("panels");
    const { data, error, loading } = useProjectResource(
      expanded ? gitDiffResourceKey(projectPath, change, { hostId }) : null,
      { active: readDiff },
    );
    return (
      <ChangesRow
        {...rowProps}
        change={change}
        diff={data ?? null}
        diffError={
          error === undefined
            ? null
            : error instanceof Error && error.message
              ? error.message
              : panelsT("failedToLoadDiff")
        }
        diffLoading={loading}
        expanded={expanded}
        projectPath={projectPath}
      />
    );
  },
);
ChangeWithDiff.displayName = "ChangeWithDiff";

/**
 * The Git panel's changes tab: the commit composer over the working tree's
 * changed files, each with its diff, and the actions to revert them. Which
 * rows are expanded and which are hidden by a revert is the changes view
 * (changes/changes-view.ts); each diff is a project resource.
 */
const GitChangesImpl = ({
  active,
  projectId: requestedProjectId,
}: GitChangesProps) => {
  const panelsT = useTranslations("panels");
  const activeProject = useIdeStore(
    (s) =>
      s.projects.find((project) => project.id === requestedProjectId) ?? null,
  );
  const [view, dispatch] = useReducer(changesViewReducer, EMPTY_CHANGES_VIEW);
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("unified");

  const projectId = activeProject?.id ?? null;
  const projectPath = activeProject?.path ?? null;
  const hostId = activeProject?.hostId;
  const wordWrapEnabled = activeProject?.ui.changesDiffWordWrap ?? true;
  const gitRefreshKey = useIdeStore((s) =>
    projectId ? (s.projectGitRefreshKeys[projectId] ?? 0) : 0,
  );
  const {
    changes,
    error: statusError,
    isRepo,
    loading: statusLoading,
    status: gitStatus,
    statusRefreshToken,
  } = useProjectGitStatus(projectPath, {
    detail: active ? "full" : "summary",
    hostId,
  });
  const hasStaleGitStatus = statusLoading && gitStatus !== null;
  const hasFreshGitStatus = statusRefreshToken === gitRefreshKey;
  // Diffs are read against a status of the current version, so a diff and
  // the row describing it agree.
  const statusCurrent = !statusLoading && hasFreshGitStatus;

  const visibleChanges = useMemo(
    () => listVisibleChanges(view, changes),
    [changes, view],
  );
  const visibleChangePaths = useMemo(
    () => visibleChanges.map((change) => change.path),
    [visibleChanges],
  );
  const expandedPathSet = useMemo(
    () => new Set(view.expanded),
    [view.expanded],
  );
  const forcedPathSet = useMemo(() => new Set(view.forced), [view.forced]);
  const revertingPathSet = useMemo(
    () => new Set(view.reverting),
    [view.reverting],
  );
  const allExpanded =
    visibleChangePaths.length > 0 &&
    visibleChangePaths.every((filePath) => expandedPathSet.has(filePath));
  const expandAllTitle = allExpanded
    ? panelsT("collapseAll")
    : panelsT("expandAll");

  useEffect(() => {
    if (statusCurrent && statusRefreshToken !== null) {
      dispatch({
        paths: changes.map((change) => change.path),
        type: "status",
        version: statusRefreshToken,
      });
    }
  }, [changes, statusCurrent, statusRefreshToken]);

  const handleTogglePath = useCallback((filePath: string) => {
    dispatch({ path: filePath, type: "toggle" });
  }, []);

  const handleToggleExpandAll = useCallback(() => {
    dispatch(
      allExpanded
        ? { type: "collapse-all" }
        : { paths: visibleChangePaths, type: "expand-all" },
    );
  }, [allExpanded, visibleChangePaths]);

  const handleForceRenderDiff = useCallback((filePath: string) => {
    dispatch({ path: filePath, type: "force-render" });
  }, []);

  const handleWordWrapChange = useCallback(
    (enabled: boolean) => {
      if (!projectId) {
        return;
      }

      useIdeStore.getState().updateProject(projectId, (project) => ({
        ...project,
        ui: {
          ...project.ui,
          changesDiffWordWrap: enabled,
        },
      }));
    },
    [projectId],
  );

  /**
   * Runs a revert of `paths`: hidden at once, then shown again if it fails,
   * or left to the next status if it succeeds.
   */
  const runRevert = useCallback(
    async (paths: string[], target: ProjectGitStatusEntry | "all") => {
      if (!projectId) {
        return;
      }
      dispatch({ paths, type: "revert-started" });
      // The revert refreshes the project's git state itself; the version
      // after it is the one whose status decides what shows again.
      const store = useIdeStore.getState();
      const outcome = await store.revertProjectChanges(projectId, target);
      if (!outcome.ok) {
        console.error("[changes] Failed to revert", outcome.error);
      }
      dispatch({
        paths,
        succeeded: outcome.ok,
        type: "revert-finished",
        version: useIdeStore.getState().projectGitRefreshKeys[projectId] ?? 0,
      });
    },
    [projectId],
  );

  const handleRevertFile = useCallback(
    (change: ProjectGitStatusEntry) => {
      if (
        !projectPath ||
        revertingPathSet.has(change.path) ||
        change.path in view.hidden
      ) {
        return;
      }
      void runRevert([change.path], change);
    },
    [projectPath, revertingPathSet, runRevert, view.hidden],
  );

  const handleRevertAllChanges = useCallback(() => {
    if (
      !projectPath ||
      visibleChanges.length === 0 ||
      view.reverting.length > 0
    ) {
      return;
    }
    void runRevert(visibleChangePaths, "all");
  }, [
    projectPath,
    runRevert,
    view.reverting.length,
    visibleChangePaths,
    visibleChanges.length,
  ]);

  if (!activeProject) {
    return null;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <GitPanelHeaderActions active={active}>
        <Tabs
          value={diffViewMode}
          onValueChange={(value) => {
            if (value === "unified" || value === "split") {
              setDiffViewMode(value);
            }
          }}
        >
          <TabsList
            aria-label={`${panelsT("unifiedDiff")} / ${panelsT("splitDiff")}`}
          >
            <TabsTrigger
              value="unified"
              aria-label={panelsT("unifiedDiff")}
              title={panelsT("unifiedDiff")}
              className="w-7 px-0"
            >
              <Rows3 className="size-3.5" />
            </TabsTrigger>
            <TabsTrigger
              value="split"
              aria-label={panelsT("splitDiff")}
              title={panelsT("splitDiff")}
              className="w-7 px-0"
            >
              <Columns2 className="size-3.5" />
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <Button
          aria-label={expandAllTitle}
          className="size-7 p-0"
          disabled={visibleChanges.length === 0}
          onClick={handleToggleExpandAll}
          title={expandAllTitle}
          type="button"
          variant="ghost"
        >
          {allExpanded ? (
            <ChevronsDownUp className="size-3.5" />
          ) : (
            <ChevronsUpDown className="size-3.5" />
          )}
        </Button>

        <WordWrapToggle
          onPressedChange={handleWordWrapChange}
          pressed={wordWrapEnabled}
        />

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                aria-label={panelsT("changesActions")}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
                title={panelsT("changesActions")}
                type="button"
              />
            }
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              disabled={
                visibleChanges.length === 0 || view.reverting.length > 0
              }
              onClick={handleRevertAllChanges}
              variant="destructive"
            >
              <Undo2 className="size-4" />
              {panelsT("revertAllChanges")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </GitPanelHeaderActions>

      {!statusError && isRepo && visibleChanges.length > 0 ? (
        <GitCommitBox
          active={active}
          projectId={activeProject.id}
          projectPath={activeProject.path}
          status={gitStatus}
          statusReady={statusCurrent}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-3 pb-3">
        {statusError ? (
          <div className="rounded-md border border-destructive-border bg-destructive-surface-muted px-3 py-2 text-destructive text-sm">
            {statusError}
          </div>
        ) : null}

        {!statusError && (!statusLoading || hasStaleGitStatus) && !isRepo ? (
          <AppShellPlaceholder message={panelsT("notGitRepository")} />
        ) : null}

        {!statusError &&
        statusLoading &&
        !hasStaleGitStatus &&
        visibleChanges.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Spinner className="size-4" />
            </div>
          </div>
        ) : null}

        {!statusError &&
        (!statusLoading || hasStaleGitStatus) &&
        isRepo &&
        visibleChanges.length === 0 ? (
          <AppShellPlaceholder message={panelsT("workingTreeClean")} />
        ) : null}

        {!statusError && visibleChanges.length > 0 ? (
          <div className="-mx-3 -mb-3">
            {visibleChanges.map((change) => (
              <ChangeWithDiff
                change={change}
                expanded={expandedPathSet.has(change.path)}
                forceRenderDiff={forcedPathSet.has(change.path)}
                hostId={hostId}
                key={`${activeProject.id}:${change.path}`}
                mode={diffViewMode}
                onForceRenderDiff={() => handleForceRenderDiff(change.path)}
                onRevert={() => handleRevertFile(change)}
                onToggle={() => handleTogglePath(change.path)}
                projectId={activeProject.id}
                projectPath={activeProject.path}
                readDiff={active && statusCurrent}
                reverting={revertingPathSet.has(change.path)}
                wordWrap={wordWrapEnabled}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** One instance per project: the view state belongs to its project. */
export const GitChanges = memo((props: GitChangesProps) => (
  <GitChangesImpl key={props.projectId} {...props} />
));
GitChanges.displayName = "GitChanges";
