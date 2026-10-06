/**
 * The client's project resources (src/lib/project-resource-cache.ts) over
 * the Route client: what each kind reads, which group of refresh keys
 * keeps it fresh, and the React hook panels read them through.
 *
 * The store's refresh keys stay the one freshness signal: whatever bumps
 * `projectGitRefreshKeys` or `projectFilesRefreshKeys` invalidates that
 * project's git or file resources here. No panel reads a refresh key to
 * decide when to fetch.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { apiClient, type ProjectFilesResponse } from "@/lib/api-client";
import { resolveRequestHost } from "@/lib/host-routing";
import {
  createProjectResourceCache,
  type ProjectScope,
  type ResourceGroup,
  type ResourceKey,
  type ResourceParams,
  type ResourceSnapshot,
  type ResourceSpec,
} from "@/lib/project-resource-cache";
import type {
  ProjectGitBranchesResponse,
  ProjectGitLogResponse,
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
  ProjectGitWorktreesResponse,
} from "@/types/ide";
import { normalizeProjectPathKey } from "./ide-state";
import { useIdeStore } from "./ide-store";
import type { PullRequestContext } from "./pull-requests/api";

export type ProjectGitStatusDetail = "full" | "summary";

/** `status` as a summary read would have reported it (no untracked files,
 * line counts or remote details), the same narrowing the host makes. */
export const narrowGitStatusToSummary = (
  status: ProjectGitStatusResponse,
): ProjectGitStatusResponse => {
  if (!status.isRepo) return status;
  const changes: ProjectGitStatusEntry[] = status.changes
    .filter((change) => change.status !== "untracked")
    .map((change) => ({ ...change, addedLines: 0, removedLines: 0 }));
  return {
    ...status,
    addedLines: 0,
    aheadCount: 0,
    baseBranch: null,
    behindCount: 0,
    changes,
    fileCount: changes.length,
    hasStagedChanges: changes.some((change) => change.staged),
    hasUnstagedChanges: changes.some((change) => change.unstaged),
    remoteName: null,
    removedLines: 0,
    stagedCount: changes.filter((change) => change.staged).length,
    unstagedCount: changes.filter((change) => change.unstaged).length,
    upstreamBranch: null,
  };
};

const hostOptions = (key: ResourceKey) => ({ hostId: key.hostId });

const specs = {
  gitStatus: {
    group: "git",
    load: (key) =>
      apiClient.gitStatus(
        {
          detail: key.params?.detail === "summary" ? "summary" : "full",
          projectPath: key.projectPath,
        },
        hostOptions(key),
      ),
    serves: (have, want) => have.detail === "full" && want.detail === "summary",
    serve: (status) => narrowGitStatusToSummary(status),
  } satisfies ResourceSpec<ProjectGitStatusResponse>,
  gitBranches: {
    group: "git",
    load: (key) =>
      apiClient.gitBranches({ projectPath: key.projectPath }, hostOptions(key)),
  } satisfies ResourceSpec<ProjectGitBranchesResponse>,
  gitWorktrees: {
    group: "git",
    load: (key) =>
      apiClient.gitWorktrees(
        { projectPath: key.projectPath },
        hostOptions(key),
      ),
  } satisfies ResourceSpec<ProjectGitWorktreesResponse>,
  gitLog: {
    group: "git",
    load: (key) =>
      apiClient.gitLog(
        {
          limit: Number(key.params?.limit ?? 100),
          projectPath: key.projectPath,
          skip: 0,
        },
        hostOptions(key),
      ),
  } satisfies ResourceSpec<ProjectGitLogResponse>,
  pullRequestContext: {
    group: "git",
    // Branches and pushes change it; a write burst does not. A refresh
    // inside this window keeps the answer unless asked for explicitly.
    minAgeMs: 15_000,
    load: async (key) =>
      (await apiClient.codePullRequests(
        { action: "context", projectPath: key.projectPath },
        hostOptions(key),
      )) as PullRequestContext,
  } satisfies ResourceSpec<PullRequestContext>,
  projectFiles: {
    group: "files",
    load: (key) =>
      apiClient.projectFiles(
        {
          directory: ".",
          maxResults: Number(key.params?.maxResults ?? 2000),
          projectPath: key.projectPath,
        },
        hostOptions(key),
      ),
    // The host walks in a fixed order and stops at the limit, so a longer
    // list begins with every shorter one.
    serves: (have, want) => Number(have.maxResults) >= Number(want.maxResults),
    serve: (payload, want) => {
      const files = payload.files.slice(0, Number(want.maxResults));
      return { count: files.length, files };
    },
  } satisfies ResourceSpec<ProjectFilesResponse>,
};

export type ProjectResourceKind = keyof typeof specs;

type ResourceData = {
  [Kind in ProjectResourceKind]: Awaited<
    ReturnType<(typeof specs)[Kind]["load"]>
  >;
};

const REFRESH_KEYS = {
  files: "projectFilesRefreshKeys",
  git: "projectGitRefreshKeys",
} as const;

/** The store's project at `scope`, open or closed. */
const findProjectId = (scope: ProjectScope) => {
  const state = useIdeStore.getState();
  const pathKey = normalizeProjectPathKey(scope.projectPath);
  return (
    [...state.projects, ...state.closedProjects].find(
      (project) =>
        normalizeProjectPathKey(project.path) === pathKey &&
        resolveRequestHost({ projectId: project.id }) === scope.hostId,
    )?.id ?? null
  );
};

const getVersion = (scope: ProjectScope, group: ResourceGroup) => {
  const projectId = findProjectId(scope);
  return projectId
    ? (useIdeStore.getState()[REFRESH_KEYS[group]][projectId] ?? 0)
    : 0;
};

export const projectResources = createProjectResourceCache({
  getVersion,
  specs,
});

// A bumped refresh key invalidates that project's resources of its group.
// Started on first use, not at import: the store may still be loading then.
let watching = false;
const watchRefreshKeys = () => {
  if (watching) return;
  watching = true;
  useIdeStore.subscribe((state, previous) => {
    for (const group of ["git", "files"] as const) {
      const keys = state[REFRESH_KEYS[group]];
      const previousKeys = previous[REFRESH_KEYS[group]];
      if (keys === previousKeys) continue;
      for (const [projectId, version] of Object.entries(keys)) {
        if (previousKeys[projectId] === version) continue;
        const project = [...state.projects, ...state.closedProjects].find(
          (item) => item.id === projectId,
        );
        if (!project) continue;
        projectResources.invalidate(
          {
            hostId: resolveRequestHost({ projectId }),
            projectPath: project.path,
          },
          group,
        );
      }
    }
  });
};

/** A resource's key; the host is the project's own unless named. */
export const projectResourceKey = <Kind extends ProjectResourceKind>(
  kind: Kind,
  projectPath: string,
  { hostId, params }: { hostId?: string; params?: ResourceParams } = {},
): ResourceKey<Kind> => ({
  hostId: hostId ?? resolveRequestHost({ projectPath }),
  kind,
  params,
  projectPath,
});

/** Reads a resource outside React (shared and cached like the hook). */
export const readProjectResource = <Kind extends ProjectResourceKind>(
  key: ResourceKey<Kind>,
  options?: { force?: boolean },
) => {
  watchRefreshKeys();
  return projectResources.read<ResourceData[Kind]>(key, options);
};

const IDLE_SNAPSHOT: ResourceSnapshot<never> = {
  data: undefined,
  error: undefined,
  fresh: false,
  loading: false,
  version: null,
};

/**
 * Follows one project resource. `active` says the reader is being shown:
 * only then is it fetched, and fetched again when the project's refresh
 * key moves. A hidden reader keeps the last data it had.
 */
export const useProjectResource = <Kind extends ProjectResourceKind>(
  key: ResourceKey<Kind> | null,
  { active = true }: { active?: boolean } = {},
) => {
  const id = key ? JSON.stringify(key) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is compared by value.
  const stableKey = useMemo(() => key, [id]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const subscriptionRef = useRef<{
    setActive: (active: boolean) => void;
  } | null>(null);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!stableKey) return () => {};
      watchRefreshKeys();
      const subscription = projectResources.subscribe(
        stableKey,
        listener,
        activeRef.current,
      );
      subscriptionRef.current = subscription;
      return () => {
        subscription.unsubscribe();
        if (subscriptionRef.current === subscription) {
          subscriptionRef.current = null;
        }
      };
    },
    [stableKey],
  );
  const getSnapshot = useCallback(
    () =>
      stableKey
        ? (projectResources.snapshot(stableKey) as ResourceSnapshot<
            ResourceData[Kind]
          >)
        : (IDLE_SNAPSHOT as ResourceSnapshot<ResourceData[Kind]>),
    [stableKey],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    subscriptionRef.current?.setActive(active);
  }, [active]);

  const refresh = useCallback(
    () =>
      stableKey
        ? projectResources.read<ResourceData[Kind]>(stableKey, { force: true })
        : Promise.resolve(undefined),
    [stableKey],
  );

  return { ...snapshot, refresh };
};
