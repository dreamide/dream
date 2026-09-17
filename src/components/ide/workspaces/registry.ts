import { Code2, GitBranch, type LucideIcon, SquareKanban } from "lucide-react";
import type { ProjectWorkspaceView } from "@/types/ide";

export const PROJECT_WORKSPACE_VIEWS = [
  "code",
  "goals",
  "kanban",
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
  labelKey: "workspaceCode" | "workspaceGoals" | "workspaceKanban";
}

// Intentionally free of component imports so the header switcher can import
// this without pulling in the full workspace body trees.
export const PROJECT_WORKSPACE_DESCRIPTORS: readonly ProjectWorkspaceDescriptor[] =
  [
    { icon: Code2, id: "code", labelKey: "workspaceCode" },
    { icon: GitBranch, id: "goals", labelKey: "workspaceGoals" },
    { icon: SquareKanban, id: "kanban", labelKey: "workspaceKanban" },
  ];

export const getProjectWorkspaceDescriptor = (view: ProjectWorkspaceView) =>
  PROJECT_WORKSPACE_DESCRIPTORS.find((descriptor) => descriptor.id === view) ??
  PROJECT_WORKSPACE_DESCRIPTORS[0];
