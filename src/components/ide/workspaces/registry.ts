import { Code2, type LucideIcon, SquareKanban, Workflow } from "lucide-react";
import type { ProjectWorkspaceView } from "@/types/ide";

export const PROJECT_WORKSPACE_VIEWS = [
  "code",
  "kanban",
  "graphs",
] as const satisfies readonly ProjectWorkspaceView[];

export const DEFAULT_PROJECT_WORKSPACE_VIEW: ProjectWorkspaceView = "code";

export const isProjectWorkspaceView = (
  value: unknown,
): value is ProjectWorkspaceView =>
  typeof value === "string" &&
  (PROJECT_WORKSPACE_VIEWS as readonly string[]).includes(value);

export interface ProjectWorkspaceDescriptor {
  icon: LucideIcon;
  id: ProjectWorkspaceView;
  /** Key inside the `workspace` i18n namespace. */
  labelKey: "workspaceCode" | "workspaceKanban" | "workspaceGraphs";
}

// Intentionally free of component imports so the header switcher can import
// this without pulling in the full workspace body trees.
export const PROJECT_WORKSPACE_DESCRIPTORS: readonly ProjectWorkspaceDescriptor[] =
  [
    { icon: Code2, id: "code", labelKey: "workspaceCode" },
    { icon: SquareKanban, id: "kanban", labelKey: "workspaceKanban" },
    { icon: Workflow, id: "graphs", labelKey: "workspaceGraphs" },
  ];

export const getProjectWorkspaceDescriptor = (view: ProjectWorkspaceView) =>
  PROJECT_WORKSPACE_DESCRIPTORS.find((descriptor) => descriptor.id === view) ??
  PROJECT_WORKSPACE_DESCRIPTORS[0];
