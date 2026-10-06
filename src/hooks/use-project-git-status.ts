import { useTranslations } from "next-intl";
import { useMemo } from "react";
import {
  type ProjectGitStatusDetail,
  projectResourceKey,
  useProjectResource,
} from "@/components/ide/project-resources";
import { getApiErrorMessage } from "@/lib/api-client";

export type { ProjectGitStatusDetail };

/**
 * A project's Git status, from the project resource cache: read once per
 * refresh however many panels ask, a summary served from a full read, and
 * read again when the project's git refresh key moves while `active`.
 */
export const useProjectGitStatus = (
  projectPath: string | null | undefined,
  options: {
    /** Whether the reader is being shown (default: yes). */
    active?: boolean;
    detail?: ProjectGitStatusDetail;
    /**
     * The project's host (absent: the project's own). The same path on two
     * hosts is two repositories, each read from its own host.
     */
    hostId?: string;
  } = {},
) => {
  const uiT = useTranslations("ui");
  const detail = options.detail ?? "full";
  const path = projectPath?.trim() ?? "";
  const key = path
    ? projectResourceKey("gitStatus", path, {
        hostId: options.hostId,
        params: { detail },
      })
    : null;
  const resource = useProjectResource(key, { active: options.active });
  const status = resource.data ?? null;
  const error = useMemo(
    () =>
      resource.loading || resource.error === undefined
        ? null
        : getApiErrorMessage(
            resource.error,
            uiT("failedToReadGitStatus"),
            (code) => uiT("requestFailedStatus", { status: code }),
          ),
    [resource.error, resource.loading, uiT],
  );

  return {
    branch: status?.branch ?? null,
    changes: status?.changes ?? [],
    error,
    isRepo: status?.isRepo ?? false,
    loading: resource.loading,
    refresh: resource.refresh,
    repoRoot: status?.repoRoot ?? null,
    status,
    /** The git refresh key the status was read at; null before a read. */
    statusRefreshToken: resource.version,
  };
};
