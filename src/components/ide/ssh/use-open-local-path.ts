import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { toast } from "sonner";
import { useIdeStore } from "../ide-store";

/**
 * Opens a path on this machine (the OS's default app), unless it belongs to
 * a project on an SSH host: that path is on the host, so a toast says
 * where instead of opening whatever happens to be at it here.
 */
export const useOpenLocalPath = () => {
  const t = useTranslations("sshHosts");
  const openExternalPath = useIdeStore((state) => state.openExternalPath);

  return useCallback(
    (path: string, projectId: string | null) => {
      const state = useIdeStore.getState();
      const project = [...state.projects, ...state.closedProjects].find(
        (item) => item.id === projectId,
      );
      if (project?.hostId) {
        const host =
          state.settings.sshHosts.find((item) => item.id === project.hostId)
            ?.label ?? project.hostId;
        toast(t("pathOnHost", { host, path }));
        return;
      }
      openExternalPath(path);
    },
    [openExternalPath, t],
  );
};
