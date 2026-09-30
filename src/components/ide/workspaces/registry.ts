import { Code2, type LucideIcon } from "lucide-react";
import type { AppView } from "@/types/ide";
import {
  APP_VIEWS,
  DEFAULT_APP_VIEW,
  normalizeAppView,
} from "../../../../electron/shared/persisted-state-codec.js";

// The app view is persisted, so which views exist is decided by the codec.
export { APP_VIEWS, DEFAULT_APP_VIEW, normalizeAppView };

export const isAppView = (value: unknown): value is AppView =>
  normalizeAppView(value) !== null;

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
