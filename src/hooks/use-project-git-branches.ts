import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import type { ProjectGitBranchesResponse } from "@/types/ide";

type ProjectGitBranchesCacheEntry = {
  error: string | null;
  refreshToken: number;
  status: ProjectGitBranchesResponse | null;
};

const gitBranchesCache = new Map<string, ProjectGitBranchesCacheEntry>();
const gitBranchesInflightRequests = new Map<
  string,
  Promise<ProjectGitBranchesCacheEntry>
>();

const getProjectPathCacheKey = (projectPath: string | null | undefined) =>
  projectPath?.trim() ?? "";

export const useProjectGitBranches = (
  projectPath: string | null | undefined,
  refreshKey?: number,
) => {
  const uiT = useTranslations("ui");
  const refreshToken = refreshKey ?? 0;
  const cacheKey = getProjectPathCacheKey(projectPath);
  const cachedEntry = cacheKey ? gitBranchesCache.get(cacheKey) : null;
  const [status, setStatus] = useState<ProjectGitBranchesResponse | null>(
    cachedEntry?.refreshToken === refreshToken
      ? (cachedEntry.status ?? null)
      : null,
  );
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
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

      const cached = gitBranchesCache.get(cacheKey);
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
        let request = gitBranchesInflightRequests.get(inflightKey);

        if (!request || force) {
          request = (async () => {
            try {
              const entry: ProjectGitBranchesCacheEntry = {
                error: null,
                refreshToken,
                status: await apiClient.gitBranches({ projectPath }),
              };
              gitBranchesCache.set(cacheKey, entry);
              return entry;
            } catch (error) {
              const entry: ProjectGitBranchesCacheEntry = {
                error: getApiErrorMessage(
                  error,
                  uiT("failedToReadGitBranches"),
                  (status) => uiT("requestFailedStatus", { status }),
                ),
                refreshToken,
                status: null,
              };
              gitBranchesCache.set(cacheKey, entry);
              return entry;
            } finally {
              gitBranchesInflightRequests.delete(inflightKey);
            }
          })();

          if (!force) {
            gitBranchesInflightRequests.set(inflightKey, request);
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
    [cacheKey, projectPath, refreshToken, uiT],
  );

  useEffect(() => {
    void refreshToken;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refresh, refreshToken]);

  const checkoutBranch = useCallback(
    async (branchName: string, create = false) => {
      if (!projectPath) {
        throw new Error(uiT("noActiveProjectSelected"));
      }

      setSwitching(true);
      setError(null);

      try {
        const payload = await apiClient.gitCheckout({
          branchName,
          create,
          projectPath,
        });
        if (cacheKey) {
          gitBranchesCache.set(cacheKey, {
            error: null,
            refreshToken,
            status: payload,
          });
        }
        setStatus(payload);
        return payload;
      } catch (error) {
        const message = getApiErrorMessage(
          error,
          uiT("failedToSwitchGitBranches"),
          (status) => uiT("requestFailedStatus", { status }),
        );
        setError(message);
        throw new Error(message);
      } finally {
        setSwitching(false);
      }
    },
    [cacheKey, projectPath, refreshToken, uiT],
  );

  const forceRefresh = useCallback(() => refresh(undefined, true), [refresh]);

  const clearError = useCallback(() => {
    setError(null);
    if (cacheKey) {
      const cached = gitBranchesCache.get(cacheKey);
      if (cached?.refreshToken === refreshToken && cached.error) {
        gitBranchesCache.set(cacheKey, {
          ...cached,
          error: null,
        });
      }
    }
  }, [cacheKey, refreshToken]);

  return {
    branches: status?.branches ?? [],
    checkoutBranch,
    clearError,
    currentBranch: status?.currentBranch ?? null,
    error,
    isRepo: status?.isRepo ?? false,
    loading,
    refresh: forceRefresh,
    repoRoot: status?.repoRoot ?? null,
    status,
    switching,
  };
};
