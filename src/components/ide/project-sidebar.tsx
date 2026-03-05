import { X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useIdeStore } from "./ide-store";

export const ProjectSidebar = () => {
  const projects = useIdeStore((s) => s.projects);
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const setActiveProjectId = useIdeStore((s) => s.setActiveProjectId);
  const closeProject = useIdeStore((s) => s.closeProject);

  return (
    <div className="flex h-full flex-col p-2">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 pr-2">
          {projects.length === 0 ? (
            <p className="rounded-md p-3 text-muted-foreground text-xs">
              Add a folder to start working on multiple projects in one
              workspace.
            </p>
          ) : (
            projects.map((project) => {
              const isActive = project.id === activeProjectId;

              return (
                <div
                  className={cn(
                    "group relative rounded-md transition-colors",
                    isActive
                      ? "bg-muted"
                      : "bg-transparent hover:bg-muted/20",
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
                      <p
                        className={cn(
                          "truncate text-xs",
                          isActive
                            ? "text-foreground/80"
                            : "text-muted-foreground",
                        )}
                      >
                        {project.path}
                      </p>
                    </div>
                  </button>
                  <div className="absolute top-2 right-2">
                    <button
                      aria-label={`Close ${project.name}`}
                      className="rounded p-0.5 opacity-30 transition-opacity hover:opacity-100"
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
    </div>
  );
};
