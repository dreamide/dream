import { useCallback } from "react";
import { getDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { ProjectConfig } from "@/types/ide";
import { getProjectHostId } from "../../../electron/shared/persisted-state-codec.js";
import { useIdeStore } from "./ide-store";

/**
 * Whether the OS file manager can show a project's folder: only the desktop
 * app can open one, and only for a folder on this machine (not an SSH host's,
 * nor a host's seen from a browser client).
 */
export const useCanOpenProjectFolder = (
  project: ProjectConfig | null | undefined,
) => {
  const isElectron = useIdeStore((state) => state.isElectron);
  return (
    isElectron &&
    Boolean(project?.path) &&
    getProjectHostId(project) === LOCAL_HOST_ID
  );
};

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
