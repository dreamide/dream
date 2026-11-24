import { useCallback } from "react";
import { getDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { ProjectConfig } from "@/types/ide";
import { getProjectHostId } from "../../../electron/shared/persisted-state-codec.js";
import { useIdeStore } from "./ide-store";

/**
<<<<<<< HEAD
 * Opens a project's folder in an editor (or the OS file manager, the
 * "file-explorer" editor). A folder on an SSH host goes along with the host
 * and target, so main can open it remotely or refuse it.
=======
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
>>>>>>> b316da739ccddabc8cba30e74d06fdbb62d6c320
 */
export const useOpenProjectInEditor = () =>
  useCallback(
    async (
      projectId: string | null,
      projectPath: string | null,
      editorId: string,
    ) => {
      if (!projectPath) {
        return;
      }

      const state = useIdeStore.getState();
      const hostId = [...state.projects, ...state.closedProjects].find(
        (project) => project.id === projectId,
      )?.hostId;
      await getDesktopApi()?.openInEditor({
        hostId,
        editorId,
        projectPath,
        sshTarget: hostId
          ? state.settings.sshHosts.find((host) => host.id === hostId)?.target
          : undefined,
      });
    },
    [],
  );

/** Opens a project's folder in the OS file manager. */
export const useOpenProjectFolder = () => {
  const openProjectInEditor = useOpenProjectInEditor();
  return useCallback(
    (projectId: string | null, projectPath: string | null) =>
      openProjectInEditor(projectId, projectPath, "file-explorer"),
    [openProjectInEditor],
  );
};
