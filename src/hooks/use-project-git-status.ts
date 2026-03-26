import { useCallback, useEffect, useState } from "react";
import type { ProjectGitStatusResponse } from "@/types/ide";

const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

export const useProjectGitStatus = (projectPath: string | null | undefined) => {
  const [status, setStatus] = useState<ProjectGitStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
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
        const response = await fetch("/api/project-git-status", {
          body: JSON.stringify({ projectPath }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal,
        });

        if (!response.ok) {
          throw new Error(await readResponseText(response));
        }

        setStatus((await response.json()) as ProjectGitStatusResponse);
      } catch (error) {
        if (signal?.aborted) {
          return;
        }

        setError(
          error instanceof Error ? error.message : "Failed to read Git status.",
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
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      controller.abort();
    };
  }, [refresh]);

  return {
    branch: status?.branch ?? null,
    changes: status?.changes ?? [],
    error,
    isRepo: status?.isRepo ?? false,
    loading,
    refresh: () => refresh(),
    repoRoot: status?.repoRoot ?? null,
    status,
  };
};
