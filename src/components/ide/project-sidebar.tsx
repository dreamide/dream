import { FolderPlus, Settings, X } from "lucide-react";
import { useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import { useIdeStore } from "./ide-store";

export const ProjectSidebar = () => {
  const projects = useIdeStore((s) => s.projects);
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const setActiveProjectId = useIdeStore((s) => s.setActiveProjectId);
  const addProject = useIdeStore((s) => s.addProject);
  const closeProject = useIdeStore((s) => s.closeProject);
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);

  const handleAddProject = useCallback(async () => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      window.alert("Open this app inside Electron to add project folders.");
      return;
    }
    const selectedPath = await desktopApi.pickProjectDirectory();
    if (!selectedPath) return;
    addProject(selectedPath);
  }, [addProject]);

  const handleOpenSettings = useCallback(() => {
    setSettingsSection("providers");
    setSettingsOpen(true);
  }, [setSettingsOpen, setSettingsSection]);

  return (
    <div className="flex h-full flex-col border-r bg-muted/25 p-2">
      <Button
        className="w-full justify-start"
        onClick={() => void handleAddProject()}
      >
        <FolderPlus className="mr-2 size-4" />
        Add Project
      </Button>

      <ScrollArea className="mt-2 min-h-0 flex-1">
        <div className="space-y-1 pr-2">
          {projects.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-muted-foreground text-xs">
              Add a folder to start working on multiple projects in one
              workspace.
            </p>
          ) : (
            projects.map((project) => {
              const isActive = project.id === activeProjectId;

              return (
                <div
                  className={cn(
                    "group relative rounded-md border transition-colors",
                    isActive
                      ? "border-primary/40 bg-primary/10"
                      : "border-transparent hover:border-border hover:bg-muted",
                  )}
                  key={project.id}
                >
                  <button
                    className="w-full rounded-[inherit] px-2 py-2 text-left"
                    onClick={() => setActiveProjectId(project.id)}
                    type="button"
                  >
                    <div className="min-w-0 pr-6 text-left">
                      <p className="truncate font-medium text-sm">
                        {project.name}
                      </p>
                      <p className="truncate text-muted-foreground text-xs">
                        {project.path}
                      </p>
                    </div>
                    <div className="mt-1 flex items-center gap-1">
                      <Badge variant="outline">{project.provider}</Badge>
                      <Badge variant="secondary">{project.model}</Badge>
                    </div>
                  </button>
                  <div className="absolute top-2 right-2">
                    <button
                      aria-label={`Close ${project.name}`}
                      className="rounded p-0.5 opacity-30 transition-opacity hover:bg-muted hover:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeProject(project.id);
                      }}
                      type="button"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      <Button
        className="mt-2 justify-start"
        onClick={handleOpenSettings}
        variant="outline"
      >
        <Settings className="mr-2 size-4" />
        Settings
      </Button>
    </div>
  );
};
