import { Code2, type LucideIcon } from "lucide-react";
import type { AppView } from "@/types/ide";

export const APP_VIEWS = ["code"] as const satisfies readonly AppView[];

export const DEFAULT_APP_VIEW: AppView = "code";

export const isAppView = (value: unknown): value is AppView =>
  typeof value === "string" && (APP_VIEWS as readonly string[]).includes(value);

/**
 * Validates a saved app view. The retired Tasks workspace (also saved as
 * "pipeline" or "kanban") is not a view any more, so it reads as `null`.
 */
export const normalizeAppView = (value: unknown): AppView | null =>
  isAppView(value) ? value : null;

export interface AppViewDescriptor {
  /** Key inside the `workspace` i18n namespace. */
  descriptionKey: "workspaceCodeDescription";
  icon: LucideIcon;
  id: AppView;
  /** Key inside the `workspace` i18n namespace. */
  labelKey: "workspaceCode";
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
];
