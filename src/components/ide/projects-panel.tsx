import {
  Archive,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FilePenLine,
  MessageSquarePlus,
  Plus,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GlowBorder } from "@/components/ui/glow-border";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import { getThreadsForProject } from "./ide-state";
import { useIdeStore } from "./ide-store";

type RenameTarget =
  | { id: string; kind: "project"; name: string }
  | { id: string; kind: "thread"; name: string };

const ProjectActionsMenu = ({
  label,
  onEdit,
  onOpenChange,
  onRemove,
  open,
}: {
  label: string;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
  onRemove: () => void;
  open: boolean;
}) => {
  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`${label} actions`}
            className="h-8 w-8 p-0"
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <Ellipsis className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onClick={onEdit}>
          <FilePenLine className="size-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onRemove}>
          <X className="size-4" />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const ThreadActionsMenu = ({
  label,
  onArchive,
  onEdit,
  onOpenChange,
  open,
}: {
  label: string;
  onArchive: () => void;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`${label} actions`}
            className="h-8 w-8 p-0"
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <Ellipsis className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onClick={onEdit}>
          <FilePenLine className="size-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onArchive}>
          <Archive className="size-4" />
          Archive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const ProjectSidebar = () => {
  const projects = useIdeStore((s) => s.projects);
  const allThreads = useIdeStore((s) => s.threads);
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const activeThreadIdByProject = useIdeStore((s) => s.activeThreadIdByProject);
  const threadSort = useIdeStore((s) => s.threadSort);
  const addThread = useIdeStore((s) => s.addThread);
  const addProject = useIdeStore((s) => s.addProject);
  const setActiveProjectId = useIdeStore((s) => s.setActiveProjectId);
  const setActiveThreadId = useIdeStore((s) => s.setActiveThreadId);
  const updateProject = useIdeStore((s) => s.updateProject);
  const updateThread = useIdeStore((s) => s.updateThread);
  const archiveThread = useIdeStore((s) => s.archiveThread);
  const closeProject = useIdeStore((s) => s.closeProject);

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

  const [collapsedProjects, setCollapsedProjects] = useState<
    Record<string, boolean>
  >({});
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");

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

  const handleProjectClick = (projectId: string) => {
    setActiveProjectId(projectId);
    toggleProjectCollapsed(projectId);
  };

  const openRenameDialog = (target: RenameTarget) => {
    setRenameTarget(target);
    setRenameValue(target.name);
  };

  const closeRenameDialog = () => {
    setRenameTarget(null);
    setRenameValue("");
  };

  const handleRenameSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextName = renameValue.trim();
    if (!renameTarget || !nextName) {
      return;
    }

    if (renameTarget.kind === "project") {
      updateProject(renameTarget.id, (current) => ({
        ...current,
        name: nextName,
      }));
    } else {
      updateThread(renameTarget.id, (current) => ({
        ...current,
        title: nextName,
      }));
    }

    closeRenameDialog();
  };

  return (
    <>
      <div
        id="projects-panel"
        className="flex h-full flex-col overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md"
      >
        <div className="flex items-center justify-between gap-2 px-2 py-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Add project"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                  onClick={() => void handleAddProject()}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <Plus className="size-4 shrink-0" />
            </TooltipTrigger>
            <TooltipContent>Add project</TooltipContent>
          </Tooltip>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 px-2 pb-3">
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
                const projectMenuId = `project:${project.id}`;
                const isProjectMenuOpen = openMenuId === projectMenuId;

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
                        onClick={() => handleProjectClick(project.id)}
                        type="button"
                      >
                        <div className="min-w-0 pr-14 text-left">
                          <p className="truncate font-medium text-muted-foreground text-sm">
                            {project.name}
                          </p>
                        </div>
                      </button>
                      <div
                        className={cn(
                          "absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5 transition-opacity",
                          isProjectMenuOpen
                            ? "opacity-100"
                            : "opacity-0 group-hover:opacity-100",
                        )}
                      >
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                aria-label="New thread"
                                className="h-8 w-8 p-0"
                                onClick={() => addThread(project.id)}
                                size="icon-sm"
                                type="button"
                                variant="ghost"
                              />
                            }
                          >
                            <MessageSquarePlus className="size-4" />
                          </TooltipTrigger>
                          <TooltipContent>New thread</TooltipContent>
                        </Tooltip>
                        <ProjectActionsMenu
                          label={project.name}
                          onEdit={() =>
                            openRenameDialog({
                              id: project.id,
                              kind: "project",
                              name: project.name,
                            })
                          }
                          onOpenChange={(open) =>
                            setOpenMenuId(open ? projectMenuId : null)
                          }
                          onRemove={() => closeProject(project.id)}
                          open={isProjectMenuOpen}
                        />
                      </div>
                    </div>

                    {!isCollapsed ? (
                      <div className="mt-1 ml-2 space-y-1 border-l border-border pl-3">
                        {projectThreads.map((thread) => {
                          const isActiveThread =
                            isActive && thread.id === activeThreadId;
                          const threadMenuId = `thread:${thread.id}`;
                          const isThreadMenuOpen = openMenuId === threadMenuId;

                          const threadItem = (
                            <div
                              className={cn(
                                "group relative min-w-0 rounded-md transition-colors",
                                isActiveThread
                                  ? "bg-background"
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
                              <div
                                className={cn(
                                  "absolute top-1/2 right-1.5 -translate-y-1/2 transition-opacity",
                                  isThreadMenuOpen
                                    ? "opacity-100"
                                    : "opacity-0 group-hover:opacity-100",
                                )}
                              >
                                <ThreadActionsMenu
                                  label={thread.title}
                                  onArchive={() => archiveThread(thread.id)}
                                  onEdit={() =>
                                    openRenameDialog({
                                      id: thread.id,
                                      kind: "thread",
                                      name: thread.title,
                                    })
                                  }
                                  onOpenChange={(open) =>
                                    setOpenMenuId(open ? threadMenuId : null)
                                  }
                                  open={isThreadMenuOpen}
                                />
                              </div>
                            </div>
                          );

                          return isActiveThread ? (
                            <GlowBorder
                              key={thread.id}
                              variant="glow"
                              className="rounded-md"
                              colors={["orange", "yellow", "orange"]}
                            >
                              {threadItem}
                            </GlowBorder>
                          ) : (
                            threadItem
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

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            closeRenameDialog();
          }
        }}
        open={renameTarget !== null}
      >
        <DialogContent className="sm:max-w-sm">
          <form className="space-y-4" onSubmit={handleRenameSubmit}>
            <DialogHeader>
              <DialogTitle>
                Rename {renameTarget?.kind === "project" ? "project" : "thread"}
              </DialogTitle>
              <DialogDescription>
                Choose a new name for this{" "}
                {renameTarget?.kind === "project" ? "project" : "thread"}.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder="Enter a name"
              value={renameValue}
            />
            <DialogFooter>
              <Button
                onClick={closeRenameDialog}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={renameValue.trim().length === 0} type="submit">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
