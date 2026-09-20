import { memo } from "react";
import type { ProjectConfig } from "@/types/ide";
import { areProjectsEqualExceptLastUsedAt } from "../ide-state";
import { useIdeStore } from "../ide-store";
import { PipelineBoard } from "./pipeline/pipeline-board";

export interface PipelineWorkspaceProps {
  active: boolean;
  project: ProjectConfig;
}

const PipelineWorkspaceComponent = ({ project }: PipelineWorkspaceProps) => {
  const projectId = project.id;
  const tasks = useIdeStore(
    (s) =>
      s.projects.find((item) => item.id === projectId)?.ui.pipelineTasks ??
      project.ui.pipelineTasks,
  );
  const config = useIdeStore(
    (s) =>
      s.projects.find((item) => item.id === projectId)?.ui.pipelineConfig ??
      project.ui.pipelineConfig,
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col p-2"
      data-project-id={projectId}
    >
      <PipelineBoard config={config} projectId={projectId} tasks={tasks} />
    </div>
  );
};

export const PipelineWorkspace = memo(
  PipelineWorkspaceComponent,
  (previous, next) =>
    previous.active === next.active &&
    areProjectsEqualExceptLastUsedAt(previous.project, next.project),
);
PipelineWorkspace.displayName = "PipelineWorkspace";
