import { useCallback, useEffect, useState } from "react";
import type {
  ProjectGitBranchesResponse,
  ProjectGitCheckoutResponse,
} from "@/types/ide";

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

const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

const getProjectPathCacheKey = (projectPath: string | null | undefined) =>
  projectPath?.trim() ?? "";

export const useProjectGitBranches = (
  projectPath: string | null | undefined,
  refreshKey?: number,
) => {
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
              const response = await fetch("/api/project-git-branches", {
                body: JSON.stringify({ projectPath }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
              });

              if (!response.ok) {
                throw new Error(await readResponseText(response));
              }

              const entry: ProjectGitBranchesCacheEntry = {
                error: null,
                refreshToken,
                status: (await response.json()) as ProjectGitBranchesResponse,
              };
              gitBranchesCache.set(cacheKey, entry);
              return entry;
            } catch (error) {
              const entry: ProjectGitBranchesCacheEntry = {
                error:
                  error instanceof Error
                    ? error.message
                    : "Failed to read Git branches.",
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
    [cacheKey, projectPath, refreshToken],
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
        throw new Error("No active project is selected.");
      }

      setSwitching(true);
      setError(null);

      try {
        const response = await fetch("/api/project-git-checkout", {
          body: JSON.stringify({
            branchName,
            create,
            projectPath,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        if (!response.ok) {
          throw new Error(await readResponseText(response));
        }

        const payload = (await response.json()) as ProjectGitCheckoutResponse;
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
        const message =
          error instanceof Error
            ? error.message
            : "Failed to switch Git branches.";
        setError(message);
        throw new Error(message);
      } finally {
        setSwitching(false);
      }
    },
    [cacheKey, projectPath, refreshToken],
  );

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
    refresh: () => refresh(undefined, true),
    repoRoot: status?.repoRoot ?? null,
    status,
    switching,
  };
};
