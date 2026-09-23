import { CircleCheckBig, Code2, type LucideIcon } from "lucide-react";
import type { AppView } from "@/types/ide";

export const APP_VIEWS = [
  "code",
  "tasks",
] as const satisfies readonly AppView[];

export const DEFAULT_APP_VIEW: AppView = "code";

export const isAppView = (value: unknown): value is AppView =>
  typeof value === "string" && (APP_VIEWS as readonly string[]).includes(value);

/**
 * Validates a saved app view. The Tasks workspace was called "pipeline" when
 * the app-level view was introduced, so that value is upgraded.
 */
export const normalizeAppView = (value: unknown): AppView | null => {
  if (value === "pipeline") {
    return "tasks";
  }
  return isAppView(value) ? value : null;
};

/**
 * Reads the retired per-project `ui.workspaceView`, which is only consulted to
 * seed the app-level view on first load after the upgrade. "pipeline" and,
 * before it, "kanban" are the Tasks workspace's former names.
 */
export const isLegacyTasksWorkspaceView = (value: unknown): boolean =>
  value === "pipeline" || value === "kanban";

export interface AppViewDescriptor {
  /** Key inside the `workspace` i18n namespace. */
  descriptionKey: "workspaceCodeDescription" | "workspaceTasksDescription";
  icon: LucideIcon;
  id: AppView;
  /** Key inside the `workspace` i18n namespace. */
  labelKey: "workspaceCode" | "workspaceTasks";
}

// Intentionally free of component imports so the header switcher can import
// this without pulling in the full workspace body trees.
export const APP_VIEW_DESCRIPTORS: readonly AppViewDescriptor[] = [
  {
    descriptionKey: "workspaceCodeDescription",
    icon: Code2,
    id: "code",
    labelKey: "workspaceCode",
  },
  {
    descriptionKey: "workspaceTasksDescription",
    icon: CircleCheckBig,
    id: "tasks",
    labelKey: "workspaceTasks",
  },
];
