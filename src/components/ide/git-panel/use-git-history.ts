import { useEffect, useMemo, useSyncExternalStore } from "react";
import { apiClient } from "@/lib/api-client";
import type { ResourceSnapshot } from "@/lib/project-resource-cache";
import type { ProjectGitLogResponse } from "@/types/ide";
import {
  projectResourceKey,
  projectResources,
  subscribeProjectResource,
  useProjectResourcesShown,
} from "../project-resources";
import { createGitHistory, GIT_LOG_PAGE_SIZE } from "./git-history";

/** Binds one history to its host and project; the view only observes its snapshot. */
export function useGitHistory(
  projectPath: string,
  hostId: string,
  active: boolean,
) {
  const history = useMemo(() => {
    const key = projectResourceKey("gitLog", projectPath, {
      hostId,
      params: { limit: GIT_LOG_PAGE_SIZE },
    });
    return createGitHistory({
      firstPage: {
        getSnapshot: () =>
          projectResources.snapshot(
            key,
          ) as ResourceSnapshot<ProjectGitLogResponse>,
        subscribe: (listener, showing) =>
          subscribeProjectResource(key, listener, showing),
      },
      loadPage: (skip, signal) =>
        apiClient.gitLog(
          { projectPath, skip, limit: GIT_LOG_PAGE_SIZE },
          { hostId, signal },
        ),
    });
  }, [projectPath, hostId]);
  const snapshot = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    history.getSnapshot,
  );
  const shown = useProjectResourcesShown();
  useEffect(() => {
    history.setActive(active && shown);
  }, [active, history, shown]);
  return { ...snapshot, loadMore: history.loadMore };
}
