import { ChevronDown, CircleCheckBig, Layers } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProjectTabIcon } from "../../header/project-tab-icon";
import { useIdeStore } from "../../ide-store";
import {
  getTaskScopeProjects,
  selectTaskEntries,
} from "../../store/task-actions";

const ALL_PROJECTS = "__all__";

/**
 * The Tasks workspace's titlebar content. It replaces the project tabs —
 * those navigate the Code workspace — with the Tasks workspace's own project filter,
 * which never touches the active project.
 */
export const TasksScopeSwitcher = () => {
  const t = useTranslations("tasks");
  const projects = useIdeStore((s) => s.projects);
  const closedProjects = useIdeStore((s) => s.closedProjects);
  const tasks = useIdeStore((s) => s.tasks);
  const tasksProjectId = useIdeStore((s) => s.tasksProjectId);
  const setTasksProjectId = useIdeStore((s) => s.setTasksProjectId);

  // Closed projects that still own tasks are listed too: the filter follows
  // the tasks, not what Code has open.
  const options = useMemo(
    () => getTaskScopeProjects(projects, closedProjects, tasks),
    [closedProjects, projects, tasks],
  );
  // Counts cover every project, whatever the filter is set to.
  const { entries } = useMemo(
    () => selectTaskEntries({ closedProjects, projects }, tasks, null),
    [closedProjects, projects, tasks],
  );
  const scopeProject =
    [...projects, ...closedProjects].find(
      (project) => project.id === tasksProjectId,
    ) ?? null;
  const taskCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      counts.set(entry.projectId, (counts.get(entry.projectId) ?? 0) + 1);
    }
    return counts;
  }, [entries]);
  const totalTasks = entries.length;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 pl-2 [-webkit-app-region:drag]">
      <div className="flex shrink-0 items-center gap-2 px-2 font-medium text-sm">
        <CircleCheckBig className="size-4 text-muted-foreground" />
        {t("title")}
      </div>
      <span aria-hidden className="text-muted-foreground/50 text-sm">
        /
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={t("scopeLabel")}
              className="h-8 min-w-0 max-w-64 gap-1.5 px-2 text-sm [-webkit-app-region:no-drag]"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              title={t("scopeLabel")}
              type="button"
              variant="ghost"
            />
          }
        >
          {scopeProject ? (
            <ProjectTabIcon
              icon={scopeProject.icon}
              projectName={scopeProject.name}
              projectPath={scopeProject.path}
            />
          ) : (
            <Layers className="size-4 text-muted-foreground" />
          )}
          <span className="truncate">
            {scopeProject?.name ?? t("scopeAll")}
          </span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64 [-webkit-app-region:no-drag]"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t("scopeLabel")}</DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuRadioGroup
            onValueChange={(value) => {
              setTasksProjectId(
                typeof value === "string" && value !== ALL_PROJECTS
                  ? value
                  : null,
              );
            }}
            value={scopeProject?.id ?? ALL_PROJECTS}
          >
            <DropdownMenuRadioItem closeOnClick={true} value={ALL_PROJECTS}>
              <Layers className="size-4" />
              <span className="truncate">{t("scopeAll")}</span>
              <span className="ml-auto pl-2 text-muted-foreground text-xs tabular-nums">
                {totalTasks}
              </span>
            </DropdownMenuRadioItem>
            {options.length > 0 ? <DropdownMenuSeparator /> : null}
            {options.map((project) => (
              <DropdownMenuRadioItem
                closeOnClick={true}
                key={project.id}
                value={project.id}
              >
                <ProjectTabIcon
                  icon={project.icon}
                  projectName={project.name}
                  projectPath={project.path}
                />
                <span className="truncate">
                  {project.name}
                  {project.worktree ? ` · ${project.worktree.branch}` : ""}
                </span>
                <span className="ml-auto pl-2 text-muted-foreground text-xs tabular-nums">
                  {taskCountByProject.get(project.id) ?? 0}
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
