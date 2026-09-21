import { memo, useMemo } from "react";
import { useIdeStore } from "../ide-store";
import {
  getRecentTaskProjects,
  getTaskProjects,
  selectTaskEntries,
} from "../store/task-actions";
import { TaskBoard } from "./tasks/task-board";

export interface TasksWorkspaceProps {
  active: boolean;
}

/**
 * The app-level Tasks surface. Tasks stay stored on their projects; this
 * gathers them for the Tasks workspace's own project filter (chosen in the
 * titlebar, independent of the Code workspace's active project) and hands the
 * board project-tagged entries. New tasks can go to recent projects as well as
 * open ones, so nothing here requires a trip to Code first.
 */
const TasksWorkspaceComponent = (_props: TasksWorkspaceProps) => {
  const projects = useIdeStore((s) => s.projects);
  const closedProjects = useIdeStore((s) => s.closedProjects);
  const tasksProjectId = useIdeStore((s) => s.tasksProjectId);

  const tasks = useIdeStore((s) => s.tasks);

  const { entries, scopeProject } = useMemo(
    () =>
      selectTaskEntries({ closedProjects, projects }, tasks, tasksProjectId),
    [closedProjects, projects, tasks, tasksProjectId],
  );
  const taskProjects = useMemo(
    () => getTaskProjects(projects, tasks),
    [projects, tasks],
  );
  const recentProjects = useMemo(
    () => getRecentTaskProjects(closedProjects),
    [closedProjects],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col p-2"
      data-tasks-scope={scopeProject ? "project" : "all"}
      data-project-id={scopeProject?.id}
    >
      <TaskBoard
        entries={entries}
        projects={taskProjects}
        recentProjects={recentProjects}
        scopeProject={scopeProject}
      />
    </div>
  );
};

export const TasksWorkspace = memo(TasksWorkspaceComponent);
TasksWorkspace.displayName = "TasksWorkspace";
