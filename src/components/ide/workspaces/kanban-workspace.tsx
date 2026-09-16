import { memo } from "react";
import type { ProjectConfig } from "@/types/ide";
import { areProjectsEqualExceptLastUsedAt } from "../ide-state";
import { useIdeStore } from "../ide-store";
import { KanbanBoard } from "./kanban/kanban-board";

export interface KanbanWorkspaceProps {
  active: boolean;
  project: ProjectConfig;
}

const KanbanWorkspaceComponent = ({ project }: KanbanWorkspaceProps) => {
  const projectId = project.id;
  const cards = useIdeStore(
    (s) =>
      s.projects.find((item) => item.id === projectId)?.ui.kanbanCards ??
      project.ui.kanbanCards,
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col p-2"
      data-project-id={projectId}
    >
      <KanbanBoard cards={cards} projectId={projectId} />
    </div>
  );
};

export const KanbanWorkspace = memo(
  KanbanWorkspaceComponent,
  (previous, next) =>
    previous.active === next.active &&
    areProjectsEqualExceptLastUsedAt(previous.project, next.project),
);
KanbanWorkspace.displayName = "KanbanWorkspace";
