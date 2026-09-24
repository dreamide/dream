import { useCallback, useEffect, useState } from "react";

export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  author: string;
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
  user: { login: string };
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

const reads = new Map<string, { time: number; promise: Promise<unknown> }>();
export async function prRequest<T>(
  projectPath: string,
  input: Record<string, unknown>,
  fresh = false,
): Promise<T> {
  const payload = { projectPath, ...input };
  const key = JSON.stringify(payload);
  const read = [
    "context",
    "list",
    "detail",
    "files",
    "comments",
    "reviews",
    "threads",
  ].includes(String(input.action));
  const cached = reads.get(key);
  if (read && !fresh && cached && Date.now() - cached.time < 15000)
    return cached.promise as Promise<T>;
  const promise = (async () => {
    const response = await fetch("/api/code-pull-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok)
      throw new Error((await response.text()) || "Unable to access GitHub.");
    return response.json() as Promise<T>;
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

export function usePullRequestContext(
  projectPath: string,
  refreshKey: number,
  active = true,
) {
  const [result, setResult] = useState<{
    path: string;
    data: PullRequestContext | null;
    error: string | null;
  }>({ path: projectPath, data: null, error: null });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    reads.clear();
    setRevision((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void prRequest<PullRequestContext>(projectPath, {
      action: "context",
      refreshKey,
      revision,
    }).then(
      (data) => {
        if (!cancelled) setResult({ path: projectPath, data, error: null });
      },
      (error: Error) => {
        if (!cancelled)
          setResult({ path: projectPath, data: null, error: error.message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [projectPath, refreshKey, revision, active]);
  useEffect(() => {
    if (!active) return;
    window.addEventListener("dream:code-pr-refresh", refresh);
    return () => {
      window.removeEventListener("dream:code-pr-refresh", refresh);
    };
  }, [active, refresh]);
  return {
    data: result.path === projectPath ? result.data : null,
    error: result.path === projectPath ? result.error : null,
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
