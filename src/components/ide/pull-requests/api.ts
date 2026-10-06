import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ApiRequestOf,
  apiClient,
  getApiErrorMessage,
} from "@/lib/api-client";
import {
  projectResourceKey,
  projectResources,
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
  checks:
    | {
        id?: string;
        name?: string;
        context?: string;
        status?: string;
        conclusion?: string;
        state?: string;
        detailsUrl?: string;
        targetUrl?: string;
      }[]
    | null;
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

/**
 * `refreshKey` and `revision` only key the read cache, so bumping one
 * refetches; they are not sent.
 */
export type PrRequestInput = PrAction & {
  refreshKey?: number | string;
  revision?: number | string;
};

const reads = new Map<string, { time: number; promise: Promise<unknown> }>();
export async function prRequest<T>(
  projectPath: string,
  { refreshKey, revision, ...input }: PrRequestInput,
  fresh = false,
): Promise<T> {
  const payload = { projectPath, ...input };
  const key = JSON.stringify({ ...payload, refreshKey, revision });
  const read = [
    "context",
    "list",
    "detail",
    "files",
    "comments",
    "reviews",
    "threads",
    "mergeInfo",
  ].includes(String(input.action));
  const cached = reads.get(key);
  if (read && !fresh && cached && Date.now() - cached.time < 15000)
    return cached.promise as Promise<T>;
  const promise = (async () => {
    try {
      // The route answers each action with its own shape; the caller names it.
      return (await apiClient.codePullRequests(payload)) as T;
    } catch (error) {
      throw new Error(getApiErrorMessage(error, "Unable to access GitHub."));
    }
  })();
  if (read) {
    if (reads.size > 150) reads.clear();
    reads.set(key, { time: Date.now(), promise });
    void promise.catch(() => {
      if (reads.get(key)?.promise === promise) reads.delete(key);
    });
  } else {
    // A successful write invalidates only Code's PR cache.
    void promise.then(
      () => {
        reads.clear();
        window.dispatchEvent(new Event("dream:code-pr-refresh"));
      },
      () => {},
    );
  }
  return promise;
}

/**
 * The pull request for the project's current branch, from the project
 * resources: read while `active`, again when the git refresh key moves
 * (at most every 15 seconds; a branch switch or push is what changes it)
 * and at once after a pull request action here.
 */
export function usePullRequestContext(projectPath: string, active = true) {
  const key = useMemo(
    () => projectResourceKey("pullRequestContext", projectPath),
    [projectPath],
  );
  const resource = useProjectResource(key, { active });
  const refresh = useCallback(() => {
    reads.clear();
    projectResources.expire(key);
  }, [key]);
  useEffect(() => {
    if (!active) return;
    window.addEventListener("dream:code-pr-refresh", refresh);
    return () => {
      window.removeEventListener("dream:code-pr-refresh", refresh);
    };
  }, [active, refresh]);
  const failed = resource.error !== undefined && !resource.loading;
  return {
    data: failed ? null : (resource.data ?? null),
    error: failed
      ? getApiErrorMessage(resource.error, "Unable to access GitHub.")
      : null,
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
