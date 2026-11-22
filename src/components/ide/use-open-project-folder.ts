import { useCallback } from "react";
import { getDesktopApi } from "@/lib/electron";
import { useIdeStore } from "./ide-store";

/**
 * Opens a project's folder in an editor (or the OS file manager, the
 * "file-explorer" editor). A folder on an SSH host goes along with the host
 * and target, so main can open it remotely or refuse it.
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
