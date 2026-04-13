import { useCallback, useEffect, useState } from "react";
import type {
  ProjectGitBranchesResponse,
  ProjectGitCheckoutResponse,
} from "@/types/ide";

const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

export const useProjectGitBranches = (
  projectPath: string | null | undefined,
  refreshKey?: number,
) => {
  const refreshToken = refreshKey ?? 0;
  const [status, setStatus] = useState<ProjectGitBranchesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!projectPath) {
        setStatus(null);
        setError(null);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/project-git-branches", {
          body: JSON.stringify({ projectPath }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal,
        });

        if (!response.ok) {
          throw new Error(await readResponseText(response));
        }

        setStatus((await response.json()) as ProjectGitBranchesResponse);
      } catch (error) {
        if (signal?.aborted) {
          return;
        }

        setError(
          error instanceof Error
            ? error.message
            : "Failed to read Git branches.",
        );
        setStatus(null);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [projectPath],
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
    [projectPath],
  );

  return {
    branches: status?.branches ?? [],
    checkoutBranch,
    currentBranch: status?.currentBranch ?? null,
    error,
    isRepo: status?.isRepo ?? false,
    loading,
    refresh: () => refresh(),
    repoRoot: status?.repoRoot ?? null,
    status,
    switching,
  };
};
