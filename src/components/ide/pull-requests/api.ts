import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type ApiRequestOf,
  apiClient,
  getApiErrorMessage,
} from "@/lib/api-client";
import type {
  ProjectScope,
  ResourceParams,
  ResourceSnapshot,
} from "@/lib/project-resource-cache";
import {
  projectResourceKey,
  projectResources,
  readProjectResource,
  useProjectResource,
} from "../project-resources";

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string;
  authorAvatarUrl?: string;
  commit?: string;
  updatedAt: string;
}
export interface PullRequestContext {
  repository: string;
  branch: string | null;
  current: PullRequestSummary | null;
}
/** One check's outcome, as the host reads GitHub's check states. */
export type CheckOutcome = "failed" | "pending" | "passed";

/** A pull request's checks summed up by the host (pull-requests.js). */
export interface PullRequestChecks {
  /** Unavailable when GitHub would not say; none when there are none. */
  outcome: "unavailable" | "none" | CheckOutcome;
  failedCount: number;
  items: {
    key: string;
    name: string;
    outcome: CheckOutcome;
    url: string | null;
  }[];
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string;
  head: string;
  base: string;
  commit: string;
  canEdit: boolean;
  viewer: string;
  reviewers: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  checks: PullRequestChecks;
}
export interface PrComment {
  id: number;
  body: string;
  user: { login: string; avatar_url?: string };
  created_at?: string;
  submitted_at?: string;
  updated_at: string;
  html_url: string;
  state?: string;
  path?: string;
  line?: number | null;
  original_line?: number;
  side?: string;
  in_reply_to_id?: number;
}
export interface PrFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}
export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

/** One GitHub pull request action, as the route validates it. */
export type PrAction = Omit<ApiRequestOf<"codePullRequests">, "projectPath">;

type ReadAction =
  | "list"
  | "detail"
  | "files"
  | "comments"
  | "reviews"
  | "threads"
  | "mergeInfo";
type ReadInput = Pick<
  PrAction,
  "repository" | "number" | "page" | "state" | "search" | "commit"
> & { action: ReadAction };
export type PrWrite = PrAction & {
  action: Exclude<PrAction["action"], ReadAction | "context">;
};

const readKey = (scope: ProjectScope, input: ReadInput) =>
  projectResourceKey("pullRequestRead", scope.projectPath, {
    hostId: scope.hostId,
    params: Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as ResourceParams,
  });

export const refreshPullRequests = (scope: ProjectScope) =>
  projectResources.expireScope(scope, [
    "pullRequestContext",
    "pullRequestRead",
  ]);

/** Writes bypass the read cache; only a successful write expires its scope. */
export async function writePullRequest<T = unknown>(
  scope: ProjectScope,
  input: PrWrite,
): Promise<T> {
  const result = await apiClient.codePullRequests(
    { ...input, projectPath: scope.projectPath },
    { hostId: scope.hostId },
  );
  // Keep a successful edit visible while the host's updated detail is read.
  if (input.action === "edit") {
    const key = readKey(scope, {
      action: "detail",
      repository: input.repository,
      number: input.number,
    });
    const current = projectResources.snapshot(key).data as
      | PullRequestDetail
      | undefined;
    if (current)
      projectResources.set(key, {
        ...current,
        ...(input.title !== undefined ? { title: input.title.trim() } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        updatedAt:
          (result as { updated_at?: string }).updated_at ?? current.updatedAt,
      });
  }
  refreshPullRequests(scope);
  return result as T;
}

export function usePullRequestRead<T>(
  scope: ProjectScope,
  input: ReadInput,
  active = true,
) {
  const resource = useProjectResource(readKey(scope, input), { active });
  return { ...resource, data: resource.data as T | undefined };
}

/** Loaded pages remain subscribed during refresh; drafts and selection stay in the view. */
export function usePrPage<T>(
  scope: ProjectScope,
  repository: string,
  number: number,
  action: "files" | "comments" | "reviews" | "threads",
  active: boolean,
  commit?: string,
) {
  const identity = JSON.stringify([
    scope.hostId,
    scope.projectPath,
    repository,
    number,
    action,
    commit,
  ]);
  const [pagination, setPagination] = useState({ identity, count: 1 });
  const count = pagination.identity === identity ? pagination.count : 1;
  const activeRef = useRef(active);
  activeRef.current = active;
  const subscriptions = useRef<ReturnType<typeof projectResources.subscribe>[]>(
    [],
  );
  const keys = Array.from({ length: count }, (_, index) =>
    readKey(scope, {
      action,
      repository,
      number,
      page: index + 1,
      commit,
    }),
  );
  const keyId = JSON.stringify(keys);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resource keys are compared by value.
  const observer = useMemo(() => {
    let previous: ResourceSnapshot<Page<T>>[] = [];
    return {
      subscribe(listener: () => void) {
        const current = keys.map((key) =>
          projectResources.subscribe(key, listener, activeRef.current),
        );
        subscriptions.current = current;
        // Also starts the store refresh-key watcher used by imperative readers.
        if (activeRef.current)
          for (const key of keys)
            void readProjectResource(key).catch(() => undefined);
        return () => {
          for (const subscription of current) subscription.unsubscribe();
          if (subscriptions.current === current) subscriptions.current = [];
        };
      },
      snapshot() {
        const next = keys.map(
          (key) => projectResources.snapshot(key) as ResourceSnapshot<Page<T>>,
        );
        if (
          next.length !== previous.length ||
          next.some((value, index) => value !== previous[index])
        )
          previous = next;
        return previous;
      },
      setActive(next: boolean) {
        for (const subscription of subscriptions.current)
          subscription.setActive(next);
        if (next)
          for (const key of keys)
            void readProjectResource(key).catch(() => undefined);
      },
    };
  }, [keyId]);
  const pages = useSyncExternalStore(
    observer.subscribe,
    observer.snapshot,
    observer.snapshot,
  );
  useEffect(() => {
    observer.setActive(active);
  }, [active, observer]);
  const failure = pages.find(
    (page) => page.error !== undefined && !page.loading,
  )?.error;
  return {
    items: useMemo(
      () => pages.flatMap((page) => page.data?.items ?? []),
      [pages],
    ),
    hasMore: pages[pages.length - 1]?.data?.hasMore ?? false,
    loading: pages.some((page) => page.loading || page.version === null),
    error:
      failure === undefined
        ? null
        : getApiErrorMessage(failure, "Unable to access GitHub."),
    more: () => setPagination({ identity, count: count + 1 }),
  };
}

/**
 * The pull request for the project's current branch, from the project
 * resources: read while `active`, again when the git refresh key moves
 * (at most every 15 seconds; a branch switch or push is what changes it)
 * and at once after a pull request action here.
 */
export function usePullRequestContext(
  projectPath: string,
  active: boolean,
  /** The project's Host (`getProjectHostId`). */
  hostId: string,
) {
  const key = useMemo(
    () => projectResourceKey("pullRequestContext", projectPath, { hostId }),
    [projectPath, hostId],
  );
  const resource = useProjectResource(key, { active });
  const refresh = useCallback(() => {
    refreshPullRequests(key);
  }, [key]);
  const failed = resource.error !== undefined && !resource.loading;
  return {
    data: failed ? null : (resource.data ?? null),
    error: failed
      ? getApiErrorMessage(resource.error, "Unable to access GitHub.")
      : null,
    /**
     * The last lookup failed (true also while it is tried again), so a null
     * `data` means no answer could be had, not that none has come yet.
     */
    lookupFailed: resource.error !== undefined,
    refresh,
  };
}

export function usePrDraft(key: string, initial = "", initialVersion?: string) {
  const [version, setVersion] = useState(() => {
    try {
      return localStorage.getItem(`${key}:version`) ?? initialVersion;
    } catch {
      return initialVersion;
    }
  });
  const read = () => {
    try {
      return localStorage.getItem(key) ?? initial;
    } catch {
      return initial;
    }
  };
  const [value, setValue] = useState(read);
  const update = (next: string) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
      if (version) localStorage.setItem(`${key}:version`, version);
    } catch {
      /* Keep the in-memory draft when storage is full. */
    }
  };
  const clear = () => {
    setValue("");
    try {
      localStorage.removeItem(key);
      localStorage.removeItem(`${key}:version`);
    } catch {
      /* Optional persistence. */
    }
  };
  const reset = () => {
    clear();
    setValue(initial);
    setVersion(initialVersion);
  };
  return { value, update, clear, reset, version };
}
