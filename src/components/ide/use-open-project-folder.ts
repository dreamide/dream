import { useCallback } from "react";
import { getDesktopApi } from "@/lib/electron";
import { useIdeStore } from "./ide-store";

/**
 * Opens a project's folder in the OS file manager. A folder on an SSH host is
 * not on this machine, so the host and target go along and main refuses it.
 */
export const useOpenProjectFolder = () =>
  useCallback(async (projectId: string | null, projectPath: string | null) => {
    if (!projectPath) {
      return;
    }

    const state = useIdeStore.getState();
    const hostId = [...state.projects, ...state.closedProjects].find(
      (project) => project.id === projectId,
    )?.hostId;
    await getDesktopApi()?.openInEditor({
      hostId,
      editorId: "file-explorer",
      projectPath,
      sshTarget: hostId
        ? state.settings.sshHosts.find((host) => host.id === hostId)?.target
        : undefined,
    });
  }, []);
