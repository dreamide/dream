import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";
import type { ProjectGitBranchDeletePreview } from "@/types/ide";

/**
 * What deleting `branchName` would cost, read each time it becomes `enabled`.
 * It is a read of one moment, so a delete sends back the head it showed: the
 * host keeps the branch if it has moved since (project-git/branches.js).
 */
export const useBranchDeletePreview = ({
  branchName,
  enabled,
  hostId,
  projectPath,
  removingWorktreePath = null,
}: {
  branchName: string;
  enabled: boolean;
  /** The project's host (absent: the project's own). */
  hostId?: string;
  projectPath: string;
  /** Asks on behalf of removing this worktree, which has the branch open. */
  removingWorktreePath?: string | null;
}) => {
  const branchT = useTranslations("branches");
  const [preview, setPreview] = useState<ProjectGitBranchDeletePreview | null>(
    null,
  );
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setError(null);
    setLoading(enabled);
    if (!enabled) {
      return;
    }

    const controller = new AbortController();
    void (async () => {
      try {
        const answer = await apiClient.gitBranchDeletePreview(
          { branchName, projectPath, removingWorktreePath },
          { hostId, signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setPreview(answer);
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(getApiErrorMessage(failure, branchT("unableToCheckBranch")));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [branchName, branchT, enabled, hostId, projectPath, removingWorktreePath]);

  return { error, loading, preview };
};
