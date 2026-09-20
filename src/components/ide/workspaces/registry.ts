import { Code2, type LucideIcon, Workflow } from "lucide-react";
import type { ProjectWorkspaceView } from "@/types/ide";

export const PROJECT_WORKSPACE_VIEWS = [
  "code",
  "pipeline",
] as const satisfies readonly ProjectWorkspaceView[];

export const DEFAULT_PROJECT_WORKSPACE_VIEW: ProjectWorkspaceView = "code";

export const isProjectWorkspaceView = (
  value: unknown,
): value is ProjectWorkspaceView =>
  typeof value === "string" &&
  (PROJECT_WORKSPACE_VIEWS as readonly string[]).includes(value);

/**
 * Validates a persisted workspace view, upgrading the retired "kanban" view to
 * its replacement. Returns `null` for anything unrecognized.
 */
export const normalizeProjectWorkspaceView = (
  value: unknown,
): ProjectWorkspaceView | null => {
  if (value === "kanban") {
    return "pipeline";
  }
  return isProjectWorkspaceView(value) ? value : null;
};

export interface ProjectWorkspaceDescriptor {
  icon: LucideIcon;
  id: ProjectWorkspaceView;
  /** Key inside the `workspace` i18n namespace. */
  labelKey: "workspaceCode" | "workspacePipeline";
}

// Intentionally free of component imports so the header switcher can import
// this without pulling in the full workspace body trees.
export const PROJECT_WORKSPACE_DESCRIPTORS: readonly ProjectWorkspaceDescriptor[] =
  [
    { icon: Code2, id: "code", labelKey: "workspaceCode" },
    { icon: Workflow, id: "pipeline", labelKey: "workspacePipeline" },
  ];

export const getProjectWorkspaceDescriptor = (view: ProjectWorkspaceView) =>
  PROJECT_WORKSPACE_DESCRIPTORS.find((descriptor) => descriptor.id === view) ??
  PROJECT_WORKSPACE_DESCRIPTORS[0];
