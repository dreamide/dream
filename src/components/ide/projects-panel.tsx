import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  MessageSquarePlus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ThreadSortOrder } from "@/types/ide";
import { getThreadsForProject } from "./ide-state";
import { useIdeStore } from "./ide-store";

const THREAD_SORT_OPTIONS: Array<{
  label: string;
  value: ThreadSortOrder;
}> = [
  { label: "Recent Activity", value: "recent" },
  { label: "Newest First", value: "createdDesc" },
  { label: "Oldest First", value: "createdAsc" },
  { label: "Title A-Z", value: "titleAsc" },
];

export const ProjectSidebar = () => {
  const projects = useIdeStore((s) => s.projects);
  const allThreads = useIdeStore((s) => s.threads);
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const activeThreadIdByProject = useIdeStore((s) => s.activeThreadIdByProject);
  const threadSort = useIdeStore((s) => s.threadSort);
  const addThread = useIdeStore((s) => s.addThread);
  const setActiveProjectId = useIdeStore((s) => s.setActiveProjectId);
  const setActiveThreadId = useIdeStore((s) => s.setActiveThreadId);
  const setThreadSort = useIdeStore((s) => s.setThreadSort);
  const closeThread = useIdeStore((s) => s.closeThread);
  const closeProject = useIdeStore((s) => s.closeProject);
  const [collapsedProjects, setCollapsedProjects] = useState<
    Record<string, boolean>
  >({});
  const threadsByProject = useMemo(() => {
    return Object.fromEntries(
      projects.map((project) => [
        project.id,
        getThreadsForProject(allThreads, project.id, threadSort),
      ]),
    );
  }, [allThreads, projects, threadSort]);

  useEffect(() => {
    if (!activeProjectId) {
      return;
    }

    setCollapsedProjects((current) => {
      if (!current[activeProjectId]) {
        return current;
      }

      return {
        ...current,
        [activeProjectId]: false,
      };
    });
  }, [activeProjectId]);

  const toggleProjectCollapsed = (projectId: string) => {
    setCollapsedProjects((current) => ({
      ...current,
      [projectId]: !current[projectId],
    }));
  };

  return (
    <div id="projects-panel" className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        <span className="px-1 font-medium text-sm">Projects</span>
        <div className="flex items-center gap-1">
          <Button
            aria-label="New thread"
            className="h-8 w-8 p-0"
            disabled={!activeProjectId}
            onClick={() => {
              if (!activeProjectId) return;
              addThread(activeProjectId);
            }}
            size="icon-sm"
            title="New thread"
            variant="ghost"
          >
            <MessageSquarePlus className="size-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label="Sort threads"
                  className="h-8 w-8 p-0"
                  size="icon-sm"
                  title="Sort threads"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <ArrowUpDown className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Sort threads</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  onValueChange={(value) =>
                    setThreadSort(value as ThreadSortOrder)
                  }
                  value={threadSort}
                >
                  {THREAD_SORT_OPTIONS.map((option) => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
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
              const isCollapsed = collapsedProjects[project.id] ?? false;
              const activeThreadId =
                activeThreadIdByProject[project.id] ?? null;
              const projectThreads = threadsByProject[project.id] ?? [];

              return (
                <div className="rounded-md" key={project.id}>
                  <div
                    className={cn(
                      "group relative flex items-center gap-1 rounded-md transition-colors",
                      isActive
                        ? "bg-muted"
                        : "bg-transparent hover:bg-muted/20",
                    )}
                  >
                    <button
                      aria-label={
                        isCollapsed
                          ? "Expand project threads"
                          : "Collapse project threads"
                      }
                      className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleProjectCollapsed(project.id);
                      }}
                      type="button"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="size-3.5" />
                      ) : (
                        <ChevronDown className="size-3.5" />
                      )}
                    </button>
                    <button
                      className="min-w-0 flex-1 rounded-[inherit] px-1 py-2 text-left"
                      onClick={() => setActiveProjectId(project.id)}
                      type="button"
                    >
                      <div className="min-w-0 pr-6 text-left">
                        <p className="truncate font-medium text-sm">
                          {project.name}
                        </p>
                      </div>
                    </button>
                    <button
                      aria-label={`Close ${project.name}`}
                      className="absolute top-2 right-2 rounded p-0.5 opacity-30 transition-opacity hover:opacity-100"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeProject(project.id);
                      }}
                      type="button"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>

                  {!isCollapsed ? (
                    <div className="mt-1 ml-[11px] space-y-1 border-l border-border pl-[18px]">
                      {projectThreads.map((thread) => {
                        const isActiveThread =
                          isActive && thread.id === activeThreadId;

                        return (
                          <div
                            className={cn(
                              "group relative rounded-md transition-colors",
                              isActiveThread
                                ? "bg-muted/70"
                                : "hover:bg-muted/20",
                            )}
                            key={thread.id}
                          >
                            <button
                              className="w-full rounded-[inherit] px-2 py-1.5 text-left"
                              onClick={() => {
                                setActiveProjectId(project.id);
                                setActiveThreadId(project.id, thread.id);
                              }}
                              type="button"
                            >
                              <div className="min-w-0 pr-6">
                                <p className="truncate text-sm">
                                  {thread.title}
                                </p>
                              </div>
                            </button>
                            <button
                              aria-label={`Close ${thread.title}`}
                              className="absolute top-1.5 right-1 rounded p-0.5 opacity-30 transition-opacity hover:opacity-100"
                              onClick={(event) => {
                                event.stopPropagation();
                                closeThread(thread.id);
                              }}
                              type="button"
                            >
                              <X className="size-3.5" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
