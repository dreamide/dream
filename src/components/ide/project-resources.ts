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
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  type ApiRequestOf,
  apiClient,
  type ProjectFilesResponse,
} from "@/lib/api-client";
import { resolveRequestHost } from "@/lib/host-routing";
import {
  createProjectResourceCache,
  type ProjectScope,
  projectScope,
  type ResourceGroup,
  type ResourceKey,
  type ResourceParams,
  type ResourceSnapshot,
  type ResourceSpec,
} from "@/lib/project-resource-cache";
import type {
  ProjectConfig,
  ProjectGitBranchesResponse,
  ProjectGitChangeStatus,
  ProjectGitDiffResponse,
  ProjectGitLogResponse,
  ProjectGitStatusEntry,
  ProjectGitStatusResponse,
  ProjectGitWorktreesResponse,
} from "@/types/ide";
import {
  narrowGitStatus,
  SUMMARY_GIT_STATUS_DETAIL,
} from "../../../electron/shared/git-changes.js";
import { normalizeProjectPathKey } from "./ide-state";
import { useIdeStore } from "./ide-store";
import type { PullRequestContext } from "./pull-requests/api";

export type ProjectGitStatusDetail = "full" | "summary";

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
    // The narrowing the host makes for a summary read (git-changes.js).
    serve: (status) => narrowGitStatus(status, SUMMARY_GIT_STATUS_DETAIL),
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
  gitDiff: {
    group: "git",
    // A panel asks for one per expanded file; each is a git process on the
    // host, so expanding many files at once reads them a few at a time.
    maxConcurrentLoads: 4,
    load: (key) =>
      apiClient.gitDiff(
        {
          filePath: String(key.params?.filePath),
          previousPath:
            typeof key.params?.previousPath === "string"
              ? key.params.previousPath
              : null,
          projectPath: key.projectPath,
          status: key.params?.status as ProjectGitChangeStatus,
        },
        hostOptions(key),
      ),
  } satisfies ResourceSpec<ProjectGitDiffResponse>,
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
  pullRequestRead: {
    group: "git",
    load: (key) =>
      apiClient.codePullRequests(
        {
          ...key.params,
          action: key.params
            ?.action as ApiRequestOf<"codePullRequests">["action"],
          projectPath: key.projectPath,
        },
        hostOptions(key),
      ),
  } satisfies ResourceSpec,
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

/** Cached scope -> projectId index rebuilt only when project lists change. */
let cachedOpenProjects: readonly ProjectConfig[] | null = null;
let cachedClosedProjects: readonly ProjectConfig[] | null = null;
let projectIdByScopeKey = new Map<string, string>();
let projectById = new Map<string, ProjectConfig>();

const scopeLookupKey = (hostId: string, projectPath: string) =>
  `${hostId}\0${normalizeProjectPathKey(projectPath)}`;

const syncProjectIndexes = () => {
  const { projects, closedProjects } = useIdeStore.getState();
  if (
    projects === cachedOpenProjects &&
    closedProjects === cachedClosedProjects
  ) {
    return;
  }
  cachedOpenProjects = projects;
  cachedClosedProjects = closedProjects;
  const nextScopeMap = new Map<string, string>();
  const nextIdMap = new Map<string, ProjectConfig>();
  for (const project of projects) {
    nextIdMap.set(project.id, project);
    nextScopeMap.set(
      scopeLookupKey(projectScope(project).hostId, project.path),
      project.id,
    );
  }
  for (const project of closedProjects) {
    nextIdMap.set(project.id, project);
    const key = scopeLookupKey(projectScope(project).hostId, project.path);
    if (!nextScopeMap.has(key)) nextScopeMap.set(key, project.id);
  }
  projectIdByScopeKey = nextScopeMap;
  projectById = nextIdMap;
};

/** The store's project at `scope`, open or closed. */
const findProjectId = (scope: ProjectScope) => {
  syncProjectIndexes();
  return (
    projectIdByScopeKey.get(scopeLookupKey(scope.hostId, scope.projectPath)) ??
    null
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

// A bumped refresh key invalidates that project's resources of its group,
// and closing a project drops its unsubscribed cached payloads.
// Started on first use, not at import: the store may still be loading then.
let watching = false;
const watchRefreshKeys = () => {
  if (watching) return;
  watching = true;
  useIdeStore.subscribe((state, previous) => {
    if (state.hosts !== previous.hosts) {
      for (const hostId of Object.keys(previous.hosts)) {
        if (!Object.hasOwn(state.hosts, hostId)) {
          projectResources.dropHost(hostId);
        }
      }
    }
    if (state.projects !== previous.projects) {
      const openIds = new Set(state.projects.map((project) => project.id));
      for (const project of previous.projects) {
        if (!openIds.has(project.id)) {
          projectResources.dropScope(projectScope(project));
        }
      }
    }
    for (const group of ["git", "files"] as const) {
      const keys = state[REFRESH_KEYS[group]];
      const previousKeys = previous[REFRESH_KEYS[group]];
      if (keys === previousKeys) continue;
      syncProjectIndexes();
      for (const [projectId, version] of Object.entries(keys)) {
        if (previousKeys[projectId] === version) continue;
        const project = projectById.get(projectId);
        if (!project) continue;
        projectResources.invalidate(projectScope(project), group);
      }
    }
  });
};

/**
 * A resource's key. A caller that knows its Project names its Host
 * (`projectScope`); without one the Host is guessed from the path, which is
 * only for callers that have nothing but a path.
 */
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

/**
 * The key of one changed file's diff, as the git status reported the file:
 * its path, its status, and the path it had before a rename or copy.
 */
export const gitDiffResourceKey = (
  projectPath: string,
  change: Pick<ProjectGitStatusEntry, "path" | "previousPath" | "status">,
  options: { hostId?: string } = {},
) =>
  projectResourceKey("gitDiff", projectPath, {
    ...options,
    params: {
      filePath: change.path,
      status: change.status,
      ...(change.previousPath ? { previousPath: change.previousPath } : {}),
    },
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

/** Subscribes outside React, with the same refresh-key watcher as the hook. */
export const subscribeProjectResource = (
  key: ResourceKey<ProjectResourceKind>,
  listener: () => void,
  active = true,
) => {
  watchRefreshKeys();
  return projectResources.subscribe(key, listener, active);
};

/**
 * Whether the readers beneath are on screen. A Project's workspace says so
 * for everything in it (`ProjectResourcesShown`), so no reader in a project
 * in the background, or under Settings, is read until its project is shown,
 * whatever it asks. A refresh key moving for such a project costs nothing
 * until then. Outside any workspace, readers are shown.
 */
const ResourcesShownContext = createContext(true);
export const ProjectResourcesShown = ResourcesShownContext.Provider;

/** Whether this reader's project is on screen (see ProjectResourcesShown). */
export const useProjectResourcesShown = () => useContext(ResourcesShownContext);

/**
 * Follows one project resource. It is read, and read again when the
 * project's refresh key moves, only while its project is shown and
 * `active` (a tab, a menu, a sidebar of it being open). A hidden reader
 * keeps the last data it had.
 */
export const useProjectResource = <Kind extends ProjectResourceKind>(
  key: ResourceKey<Kind> | null,
  { active: wanted = true }: { active?: boolean } = {},
) => {
  const shown = useProjectResourcesShown();
  const active = wanted && shown;
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
      const subscription = subscribeProjectResource(
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
