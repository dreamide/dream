import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
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

const getProjectPathCacheKey = (projectPath: string | null | undefined) =>
  projectPath?.trim() ?? "";

export type ProjectGitStatusDetail = "full" | "summary";

const getGitStatusCacheKey = (
  projectPath: string | null | undefined,
  detail: ProjectGitStatusDetail,
  hostId: string,
) => {
  const projectPathCacheKey = getProjectPathCacheKey(projectPath);
  return projectPathCacheKey
    ? `${hostId}\0${projectPathCacheKey}\0${detail}`
    : "";
};

/**
 * A project's Git status at `refreshToken`, read once for every caller that
 * asks for it at that token: from the cache, from a read already under way,
 * or from the host. `force` reads again regardless.
 */
export const readProjectGitStatus = ({
  describeError,
  detail = "full",
  force = false,
  hostId = LOCAL_HOST_ID,
  projectPath,
  refreshToken,
}: {
  describeError: (error: unknown) => string;
  detail?: ProjectGitStatusDetail;
  force?: boolean;
  hostId?: string;
  projectPath: string;
  refreshToken: number;
}): Promise<ProjectGitStatusCacheEntry> => {
  const cacheKey = getGitStatusCacheKey(projectPath, detail, hostId);
  const cached = gitStatusCache.get(cacheKey);
  if (!force && cached?.refreshToken === refreshToken) {
    return Promise.resolve(cached);
  }

  const inflightKey = `${cacheKey}:${refreshToken}`;
  const inflight = gitStatusInflightRequests.get(inflightKey);
  if (inflight && !force) {
    return inflight;
  }

  const request = (async () => {
    try {
      const entry: ProjectGitStatusCacheEntry = {
        error: null,
        refreshToken,
        status: await apiClient.gitStatus({ detail, projectPath }, { hostId }),
      };
      gitStatusCache.set(cacheKey, entry);
      notifyGitStatusCacheListeners(cacheKey);
      return entry;
    } catch (error) {
      const entry: ProjectGitStatusCacheEntry = {
        error: describeError(error),
        refreshToken,
        status: null,
      };
      gitStatusCache.set(cacheKey, entry);
      notifyGitStatusCacheListeners(cacheKey);
      return entry;
    } finally {
      // Only an unforced read is shared, so only one can be in the map.
      if (!force) {
        gitStatusInflightRequests.delete(inflightKey);
      }
    }
  })();

  if (!force) {
    gitStatusInflightRequests.set(inflightKey, request);
  }
  return request;
};

export const useProjectGitStatus = (
  projectPath: string | null | undefined,
  refreshKey?: number,
  options: {
    detail?: ProjectGitStatusDetail;
    /**
     * The project's host (absent: the local host). The same path on two
     * hosts is two repositories, each read from its own host.
     */
    hostId?: string;
  } = {},
) => {
  const uiT = useTranslations("ui");
  const detail = options.detail ?? "full";
  const hostId = options.hostId ?? LOCAL_HOST_ID;
  const refreshToken = refreshKey ?? 0;
  const cacheKey = getGitStatusCacheKey(projectPath, detail, hostId);
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
  const [statusRefreshToken, setStatusRefreshToken] = useState<number | null>(
    cachedEntry?.refreshToken === refreshToken ? refreshToken : null,
  );

  const refresh = useCallback(
    async (signal?: AbortSignal, force = false) => {
      if (!cacheKey || !projectPath) {
        setStatus(null);
        setError(null);
        setStatusRefreshToken(null);
        setLoading(false);
        return;
      }

      const cached = gitStatusCache.get(cacheKey);
      if (!force && cached?.refreshToken === refreshToken) {
        setStatus(cached.status);
        setError(cached.error);
        setStatusRefreshToken(cached.refreshToken);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);
      setStatusRefreshToken(null);

      try {
        const entry = await readProjectGitStatus({
          describeError: (error) =>
            getApiErrorMessage(error, uiT("failedToReadGitStatus"), (status) =>
              uiT("requestFailedStatus", { status }),
            ),
          detail,
          force,
          hostId,
          projectPath,
          refreshToken,
        });
        if (signal?.aborted) {
          return;
        }

        setStatus(entry.status);
        setError(entry.error);
        setStatusRefreshToken(entry.refreshToken);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [cacheKey, detail, projectPath, refreshToken, uiT, hostId],
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
      setStatusRefreshToken(entry.refreshToken);
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
    statusRefreshToken,
  };
};
