import { useCallback } from "react";
import { getDesktopApi } from "@/lib/electron";
import type { DesktopApi, DetectedEditor, ProjectConfig } from "@/types/ide";
import {
  getProjectHostId,
  LOCAL_HOST_ID,
} from "../../../electron/shared/persisted-state-codec.js";
import { useHostChoices } from "./ssh/use-host-choices";
import { useDetectedEditors } from "./use-detected-editors";

type ProjectDirectory = Pick<ProjectConfig, "hostId" | "path">;

export const projectEditorDestinations = (
  project: ProjectDirectory | null,
  editors: DetectedEditor[],
  hosts: ReadonlyArray<{ id: string; target: string }>,
  desktop: Pick<DesktopApi, "openInEditor"> | null,
) => {
  if (!desktop || !project?.path) return [];

  const hostId = getProjectHostId(project);
  const local = hostId === LOCAL_HOST_ID;
  const sshTarget = local
    ? undefined
    : hosts.find((host) => host.id === hostId)?.target.trim();
  if (!local && !sshTarget) return [];

  return editors
    .filter((editor) => local || editor.supportsRemote)
    .map((editor) => ({
      editor,
      open: () =>
        desktop.openInEditor({
          editorId: editor.id,
          hostId: local ? undefined : hostId,
          projectPath: project.path,
          sshTarget,
        }),
    }));
};

export type ProjectEditorDestination = ReturnType<
  typeof projectEditorDestinations
>[number];

/** Each displayed destination carries the same launch decision that admitted it. */
export const useProjectEditorDestinations = (isMacOs: boolean) => {
  const editors = useDetectedEditors(isMacOs);
  const hosts = useHostChoices();
  return useCallback(
    (project: ProjectDirectory | null) =>
      projectEditorDestinations(project, editors, hosts, getDesktopApi()),
    [editors, hosts],
  );
};
