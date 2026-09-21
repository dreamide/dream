import { memo } from "react";
import type { ProjectConfig } from "@/types/ide";
import { areProjectsEqualExceptLastUsedAt } from "./ide-state";
import { CodeWorkspace } from "./workspaces/code-workspace";

export interface ProjectWorkspaceProps {
  active: boolean;
  project: ProjectConfig;
}

/**
 * A project's own surface. App-level views such as Tasks are mounted by
 * the shell above every project, so this always stays mounted underneath them:
 * streaming chats, terminals, browser webviews, and the ResizeObserver-driven
 * layout survive, and chat panels keep processing queued task submissions.
 * `active` is false while another surface is on top, which keeps this
 * workspace's shortcuts and native webviews disabled.
 */
const ProjectWorkspaceComponent = ({
  active,
  project,
}: ProjectWorkspaceProps) => (
  <div
    className="relative h-full min-h-0 overflow-hidden bg-surface-50 dark:bg-surface-900"
    data-workspace-view="code"
  >
    <CodeWorkspace active={active} project={project} />
  </div>
);

export const ProjectWorkspace = memo(
  ProjectWorkspaceComponent,
  (previous, next) =>
    previous.active === next.active &&
    areProjectsEqualExceptLastUsedAt(previous.project, next.project),
);
ProjectWorkspace.displayName = "ProjectWorkspace";
