import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { useIdeStore } from "@/components/ide/ide-store";
import {
  projectResourceKey,
  projectResources,
  useProjectResource,
} from "@/components/ide/project-resources";
import { getApiErrorMessage } from "@/lib/api-client";

/**
 * A project's local branches, from the project resource cache (read again
 * when the project's git refresh key moves while `active`), and switching
 * between them or deleting one (git writes of `projectId`:
 * store/git-write-actions.ts).
 */
export const useProjectGitBranches = (
  projectPath: string | null | undefined,
  {
    active = true,
    hostId,
    projectId,
  }: {
    /** Whether the reader is being shown (default: yes). */
    active?: boolean;
    /** The project's host (absent: the project's own). */
    hostId?: string;
    /** The project a checkout writes to. */
    projectId: string;
  },
) => {
  const branchT = useTranslations("branches");
  const uiT = useTranslations("ui");
  const path = projectPath?.trim() ?? "";
  const key = useMemo(
    () => (path ? projectResourceKey("gitBranches", path, { hostId }) : null),
    [hostId, path],
  );
  const resource = useProjectResource(key, { active });
  const [switching, setSwitching] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  // An error the user dismissed stays dismissed until another one comes.
  const [dismissedError, setDismissedError] = useState<unknown>(undefined);

  const readError = useMemo(
    () =>
      resource.loading ||
      resource.error === undefined ||
      resource.error === dismissedError
        ? null
        : getApiErrorMessage(
            resource.error,
            uiT("failedToReadGitBranches"),
            (status) => uiT("requestFailedStatus", { status }),
          ),
    [dismissedError, resource.error, resource.loading, uiT],
  );

  const checkoutBranch = useCallback(
    async (branchName: string, create = false) => {
      if (!key) {
        throw new Error(uiT("noActiveProjectSelected"));
      }

      setSwitching(true);
      setCheckoutError(null);
      const outcome = await useIdeStore
        .getState()
        .checkoutProjectBranch(projectId, branchName, { create });
      setSwitching(false);
      if (outcome.ok) {
        // The checkout answers the branch list; show it at once.
        projectResources.set(key, outcome.result);
        return outcome.result;
      }
      const message = getApiErrorMessage(
        outcome.error,
        uiT("failedToSwitchGitBranches"),
        (status) => uiT("requestFailedStatus", { status }),
      );
      setCheckoutError(message);
      throw new Error(message);
    },
    [key, projectId, uiT],
  );

  /** Answers once the branch is gone; throws a displayable error if not. */
  const deleteBranch = useCallback(
    async (branchName: string, confirmedHead: string | null) => {
      if (!key) {
        throw new Error(uiT("noActiveProjectSelected"));
      }

      setSwitching(true);
      const outcome = await useIdeStore
        .getState()
        .deleteProjectBranch(projectId, branchName, { confirmedHead });
      setSwitching(false);
      if (outcome.ok) {
        projectResources.set(key, outcome.result);
        return;
      }
      throw new Error(
        getApiErrorMessage(
          outcome.error,
          branchT("unableToDeleteBranch"),
          (status) => uiT("requestFailedStatus", { status }),
        ),
      );
    },
    [branchT, key, projectId, uiT],
  );

  const clearError = useCallback(() => {
    setCheckoutError(null);
    setDismissedError(resource.error);
  }, [resource.error]);

  const status = resource.data ?? null;
  return {
    branches: status?.branches ?? [],
    checkoutBranch,
    clearError,
    currentBranch: status?.currentBranch ?? null,
    deleteBranch,
    error: checkoutError ?? readError,
    isRepo: status?.isRepo ?? false,
    loading: resource.loading,
    refresh: resource.refresh,
    repoRoot: status?.repoRoot ?? null,
    status,
    switching,
  };
};
