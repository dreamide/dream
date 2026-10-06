import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import {
  projectResourceKey,
  projectResources,
  useProjectResource,
} from "@/components/ide/project-resources";
import { apiClient, getApiErrorMessage } from "@/lib/api-client";

/**
 * A project's local branches, from the project resource cache (read again
 * when the project's git refresh key moves while `active`), and switching
 * between them.
 */
export const useProjectGitBranches = (
  projectPath: string | null | undefined,
  {
    active = true,
    hostId,
  }: {
    /** Whether the reader is being shown (default: yes). */
    active?: boolean;
    /** The project's host (absent: the project's own). */
    hostId?: string;
  } = {},
) => {
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

      try {
        const payload = await apiClient.gitCheckout(
          { branchName, create, projectPath: key.projectPath },
          { hostId: key.hostId },
        );
        projectResources.set(key, payload);
        return payload;
      } catch (error) {
        const message = getApiErrorMessage(
          error,
          uiT("failedToSwitchGitBranches"),
          (status) => uiT("requestFailedStatus", { status }),
        );
        setCheckoutError(message);
        throw new Error(message);
      } finally {
        setSwitching(false);
      }
    },
    [key, uiT],
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
    error: checkoutError ?? readError,
    isRepo: status?.isRepo ?? false,
    loading: resource.loading,
    refresh: resource.refresh,
    repoRoot: status?.repoRoot ?? null,
    status,
    switching,
  };
};
