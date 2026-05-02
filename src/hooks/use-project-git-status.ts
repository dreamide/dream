import { useCallback, useEffect, useState } from "react";
import type { ProjectGitStatusResponse } from "@/types/ide";

type ProjectGitStatusCacheEntry = {
  error: string | null;
  refreshToken: number;
  status: ProjectGitStatusResponse | null;
};

const gitStatusCache = new Map<string, ProjectGitStatusCacheEntry>();
const gitStatusInflightRequests = new Map<
  string,
  Promise<ProjectGitStatusCacheEntry>
>();
const gitStatusCacheListeners = new Map<string, Set<() => void>>();

const notifyGitStatusCacheListeners = (cacheKey: string) => {
  const listeners = gitStatusCacheListeners.get(cacheKey);
  if (!listeners) {
    return;
  }

  for (const listener of listeners) {
    listener();
  }
};

const subscribeToGitStatusCache = (cacheKey: string, listener: () => void) => {
  let listeners = gitStatusCacheListeners.get(cacheKey);
  if (!listeners) {
    listeners = new Set();
    gitStatusCacheListeners.set(cacheKey, listeners);
  }

  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      gitStatusCacheListeners.delete(cacheKey);
    }
  };
};

const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

const getProjectPathCacheKey = (projectPath: string | null | undefined) =>
  projectPath?.trim() ?? "";

export const useProjectGitStatus = (
  projectPath: string | null | undefined,
  refreshKey?: number,
) => {
  const refreshToken = refreshKey ?? 0;
  const cacheKey = getProjectPathCacheKey(projectPath);
  const cachedEntry = cacheKey ? gitStatusCache.get(cacheKey) : null;
  const [status, setStatus] = useState<ProjectGitStatusResponse | null>(
    cachedEntry?.refreshToken === refreshToken
      ? (cachedEntry.status ?? null)
      : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(
    cachedEntry?.refreshToken === refreshToken
      ? (cachedEntry.error ?? null)
      : null,
  );

  const refresh = useCallback(
    async (signal?: AbortSignal, force = false) => {
      if (!cacheKey || !projectPath) {
        setStatus(null);
        setError(null);
        setLoading(false);
        return;
      }

      const cached = gitStatusCache.get(cacheKey);
      if (!force && cached?.refreshToken === refreshToken) {
        setStatus(cached.status);
        setError(cached.error);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const inflightKey = `${cacheKey}:${refreshToken}`;
        let request = gitStatusInflightRequests.get(inflightKey);

        if (!request || force) {
          request = (async () => {
            try {
              const response = await fetch("/api/project-git-status", {
                body: JSON.stringify({ projectPath }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
              });

              if (!response.ok) {
                throw new Error(await readResponseText(response));
              }

              const entry: ProjectGitStatusCacheEntry = {
                error: null,
                refreshToken,
                status: (await response.json()) as ProjectGitStatusResponse,
              };
              gitStatusCache.set(cacheKey, entry);
              notifyGitStatusCacheListeners(cacheKey);
              return entry;
            } catch (error) {
              const entry: ProjectGitStatusCacheEntry = {
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to read Git status.",
                refreshToken,
                status: null,
              };
              gitStatusCache.set(cacheKey, entry);
              notifyGitStatusCacheListeners(cacheKey);
              return entry;
            } finally {
              gitStatusInflightRequests.delete(inflightKey);
            }
          })();

          if (!force) {
            gitStatusInflightRequests.set(inflightKey, request);
          }
        }

        const entry = await request;
        if (signal?.aborted) {
          return;
        }

        setStatus(entry.status);
        setError(entry.error);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [cacheKey, projectPath, refreshToken],
  );

  useEffect(() => {
    if (!cacheKey) {
      return;
    }

    return subscribeToGitStatusCache(cacheKey, () => {
      const entry = gitStatusCache.get(cacheKey);
      if (entry?.refreshToken !== refreshToken) {
        return;
      }

      setStatus(entry.status);
      setError(entry.error);
      setLoading(false);
    });
  }, [cacheKey, refreshToken]);

  useEffect(() => {
    void refreshToken;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refresh, refreshToken]);

  return {
    branch: status?.branch ?? null,
    changes: status?.changes ?? [],
    error,
    isRepo: status?.isRepo ?? false,
    loading,
    refresh: () => refresh(undefined, true),
    repoRoot: status?.repoRoot ?? null,
    status,
  };
};
