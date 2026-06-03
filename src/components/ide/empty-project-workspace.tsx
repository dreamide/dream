import { Folder, FolderOpen, FolderTree, History } from "lucide-react";
import { useCallback, useMemo } from "react";
import dreamSvg from "@/assets/dream.svg";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { getDesktopApi } from "@/lib/electron";
import { ProjectTabIcon } from "./header/project-tab-icon";
import { useIdeStore } from "./ide-store";

export const EmptyProjectWorkspace = () => {
  const closedProjects = useIdeStore((s) => s.closedProjects);
  const addProject = useIdeStore((s) => s.addProject);

  const recentProjects = useMemo(
    () => [...closedProjects].reverse().slice(0, 6),
    [closedProjects],
  );

  const handleOpenFolder = useCallback(async () => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      window.alert("Open this app inside Electron to add project folders.");
      return;
    }

    const selectedPath = await desktopApi.pickProjectDirectory();
    if (!selectedPath) {
      return;
    }

    addProject(selectedPath);
  }, [addProject]);

  return (
    <Empty className="h-full gap-6 rounded-none border-0 p-6">
      <EmptyHeader className="max-w-xl gap-4">
        <img alt="" className="size-16" draggable={false} src={dreamSvg} />
        <EmptyTitle>Get started</EmptyTitle>
      </EmptyHeader>

      <EmptyContent className="max-w-xl gap-10">
        <Button onClick={() => void handleOpenFolder()} size="lg">
          <FolderOpen className="size-4" />
          Open Folder
        </Button>

        {recentProjects.length > 0 ? (
          <div className="flex w-full flex-col items-stretch gap-2">
            <div className="flex items-center gap-2 px-1 font-medium text-muted-foreground text-sm">
              <History className="size-3.5" />
              Recently closed
            </div>
            <div className="grid w-full gap-1">
              {recentProjects.map((project) => {
                const isWorktree = project.worktree?.kind === "worktree";

                return (
                  <button
                    className="group flex min-h-12 w-full min-w-0 items-center gap-3 rounded-sm border border-transparent px-3 py-2 text-left text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:border-surface-300 dark:hover:bg-[color-mix(in_oklab,var(--muted)_70%,var(--background))] dark:focus-visible:border-surface-700 focus-visible:outline-none"
                    key={project.id}
                    onClick={() => addProject(project.path)}
                    type="button"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      {isWorktree ? (
                        <FolderTree className="size-4" />
                      ) : project.icon ? (
                        <ProjectTabIcon
                          icon={project.icon}
                          projectName={project.name}
                          projectPath={project.path}
                        />
                      ) : (
                        <Folder className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground text-sm">
                        {project.name}
                      </span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {isWorktree ? "worktree" : project.path}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </EmptyContent>
    </Empty>
  );
};
