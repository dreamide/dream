import { type ComponentType, memo, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { ProjectConfig, ProjectWorkspaceView } from "@/types/ide";
import { areProjectsEqualExceptLastUsedAt } from "./ide-state";
import { useIdeStore } from "./ide-store";
import { CodeWorkspace } from "./workspaces/code-workspace";
import { KanbanWorkspace } from "./workspaces/kanban-workspace";

export interface ProjectWorkspaceProps {
  active: boolean;
  project: ProjectConfig;
}

interface WorkspaceBodyProps {
  active: boolean;
  project: ProjectConfig;
}

const WORKSPACE_COMPONENTS: Record<
  ProjectWorkspaceView,
  ComponentType<WorkspaceBodyProps>
> = {
  code: CodeWorkspace,
  kanban: KanbanWorkspace,
};

/**
 * Dispatches a project to its selected workspace body. Visited workspaces stay
 * mounted (hidden with `visibility` rather than unmounted or `display: none`)
 * so streaming chats, terminals, browser webviews, and the code workspace's
 * ResizeObserver-driven layout all survive switching back and forth.
 *
 * The Code workspace also mounts when restoring directly into Kanban so its
 * chat panels can process queued card submissions. Only the selected body is
 * active, keeping hidden workspace shortcuts and native webviews disabled.
 */
const ProjectWorkspaceComponent = ({
  active,
  project,
}: ProjectWorkspaceProps) => {
  const projectId = project.id;
  const workspaceView = useIdeStore(
    (s) =>
      s.projects.find((item) => item.id === projectId)?.ui.workspaceView ??
      project.ui.workspaceView,
  );
  const [visitedViews, setVisitedViews] = useState(
    () => new Set<ProjectWorkspaceView>(["code", workspaceView]),
  );

  useEffect(() => {
    setVisitedViews((views) => {
      if (views.has(workspaceView)) {
        return views;
      }

      return new Set([...views, workspaceView]);
    });
  }, [workspaceView]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      {(Object.keys(WORKSPACE_COMPONENTS) as ProjectWorkspaceView[])
        .filter((view) => visitedViews.has(view))
        .map((view) => {
          const Body = WORKSPACE_COMPONENTS[view];
          const selected = view === workspaceView;

          return (
            <div
              aria-hidden={!selected}
              className={cn(
                "absolute inset-0 min-h-0",
                selected
                  ? "visible pointer-events-auto"
                  : "invisible pointer-events-none",
              )}
              data-workspace-view={view}
              inert={!selected}
              key={view}
            >
              <Body active={active && selected} project={project} />
            </div>
          );
        })}
    </div>
  );
};

export const ProjectWorkspace = memo(
  ProjectWorkspaceComponent,
  (previous, next) =>
    previous.active === next.active &&
    areProjectsEqualExceptLastUsedAt(previous.project, next.project),
);
ProjectWorkspace.displayName = "ProjectWorkspace";
