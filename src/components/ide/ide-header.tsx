import {
  Ellipsis,
  ExternalLink,
  FilePenLine,
  Minus,
  PanelLeft,
  PanelRight,
  Plus,
  Settings,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";

import {
  type FormEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import type { DetectedEditor } from "@/types/ide";
import { ToggleButton } from "./ide-helpers";
import { useIdeStore } from "./ide-store";

const PROJECT_TAB_GAP = 4;
const PROJECT_TAB_MIN_WIDTH = 144;
const PROJECT_TAB_MAX_WIDTH = 220;
const PROJECT_DRAG_THRESHOLD = 4;

type ProjectDragState = {
  currentIndex: number;
  currentX: number;
  initialIndex: number;
  moved: boolean;
  pointerId: number;
  projectId: string;
  startX: number;
};

type RenameTarget = {
  id: string;
  name: string;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const moveProject = <T,>(items: T[], fromIndex: number, toIndex: number) => {
  if (fromIndex === toIndex) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  if (!movedItem) {
    return items;
  }

  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
};

export const IdeHeader = () => {
  const appReady = useIdeStore((s) => s.appReady);
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const isElectron = useIdeStore((s) => s.isElectron);
  const panelVisibility = useIdeStore((s) => s.panelVisibility);
  const projects = useIdeStore((s) => s.projects);
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const togglePanel = useIdeStore((s) => s.togglePanel);
  const setActiveProjectId = useIdeStore((s) => s.setActiveProjectId);
  const setProjects = useIdeStore((s) => s.setProjects);
  const closeProject = useIdeStore((s) => s.closeProject);
  const updateProject = useIdeStore((s) => s.updateProject);
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);
  const openProjectTerminal = useIdeStore((s) => s.openProjectTerminal);
  const projectTerminalSessionIds = useIdeStore(
    (s) => s.projectTerminalSessionIds,
  );
  const projectTerminalPanelOpen = useIdeStore(
    (s) => s.projectTerminalPanelOpen,
  );

  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null;
  const projectTabsScrollRef = useRef<HTMLDivElement | null>(null);
  const addProjectButtonRef = useRef<HTMLButtonElement | null>(null);
  const suppressProjectClickRef = useRef<string | null>(null);
  const [dragProject, setDragProject] = useState<ProjectDragState | null>(null);
  const [detectedEditors, setDetectedEditors] = useState<DetectedEditor[]>([]);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(
    null,
  );
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [projectTabWidth, setProjectTabWidth] = useState(PROJECT_TAB_MAX_WIDTH);
  const terminalOpen = activeProject
    ? (projectTerminalSessionIds[activeProject.id]?.length ?? 0) > 0
    : false;
  const terminalHiddenWithActiveSession =
    terminalOpen && !projectTerminalPanelOpen;
  const dragDistance = dragProject
    ? dragProject.currentX - dragProject.startX
    : 0;
  const dragStep = projectTabWidth + PROJECT_TAB_GAP;

  const handleOpenSettings = useCallback(() => {
    setSettingsSection("appearance");
    setSettingsOpen(true);
  }, [setSettingsOpen, setSettingsSection]);

  const handleAddProject = useCallback(async () => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      window.alert("Open this app inside Electron to add project folders.");
      return;
    }

    const selectedPath = await desktopApi.pickProjectDirectory();
    if (!selectedPath) {
      return;
    }

    useIdeStore.getState().addProject(selectedPath);
  }, []);

  const handleOpenTerminal = useCallback(() => {
    if (!activeProject) {
      return;
    }

    void openProjectTerminal(activeProject.id);
  }, [activeProject, openProjectTerminal]);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api) {
      return;
    }

    void api.detectEditors().then(setDetectedEditors);
  }, []);

  const closeRenameDialog = useCallback(() => {
    setRenameTarget(null);
    setRenameValue("");
  }, []);

  const handleRenameSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const nextName = renameValue.trim();
      if (!renameTarget || !nextName) {
        return;
      }

      updateProject(renameTarget.id, (current) => ({
        ...current,
        name: nextName,
      }));

      closeRenameDialog();
    },
    [closeRenameDialog, renameTarget, renameValue, updateProject],
  );

  const measureProjectTabWidth = useCallback(() => {
    const containerWidth = projectTabsScrollRef.current?.clientWidth ?? 0;
    const addButtonWidth = addProjectButtonRef.current?.offsetWidth ?? 0;

    if (!projects.length || !containerWidth) {
      setProjectTabWidth(PROJECT_TAB_MAX_WIDTH);
      return;
    }

    const availableWidth =
      containerWidth - addButtonWidth - PROJECT_TAB_GAP * projects.length;
    const nextWidth = clamp(
      availableWidth / projects.length,
      PROJECT_TAB_MIN_WIDTH,
      PROJECT_TAB_MAX_WIDTH,
    );

    setProjectTabWidth(nextWidth);
  }, [projects.length]);

  useEffect(() => {
    measureProjectTabWidth();

    const container = projectTabsScrollRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver(() => {
      measureProjectTabWidth();
    });

    observer.observe(container);

    if (addProjectButtonRef.current) {
      observer.observe(addProjectButtonRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, [measureProjectTabWidth]);

  const finishProjectDrag = useCallback(
    (
      projectId: string,
      pointerId: number,
      shouldCommit: boolean,
      currentTarget: HTMLButtonElement,
    ) => {
      setDragProject((currentDragProject) => {
        if (
          !currentDragProject ||
          currentDragProject.projectId !== projectId ||
          currentDragProject.pointerId !== pointerId
        ) {
          return currentDragProject;
        }

        if (currentTarget.hasPointerCapture(pointerId)) {
          currentTarget.releasePointerCapture(pointerId);
        }

        if (
          shouldCommit &&
          currentDragProject.moved &&
          currentDragProject.initialIndex !== currentDragProject.currentIndex
        ) {
          setProjects(
            moveProject(
              projects,
              currentDragProject.initialIndex,
              currentDragProject.currentIndex,
            ),
          );
        }

        if (currentDragProject.moved) {
          suppressProjectClickRef.current = currentDragProject.projectId;
        }

        return null;
      });
    },
    [projects, setProjects],
  );

  const handleProjectPointerDown = useCallback(
    (
      event: PointerEvent<HTMLButtonElement>,
      projectId: string,
      projectIndex: number,
    ) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragProject({
        currentIndex: projectIndex,
        currentX: event.clientX,
        initialIndex: projectIndex,
        moved: false,
        pointerId: event.pointerId,
        projectId,
        startX: event.clientX,
      });
    },
    [],
  );

  const handleProjectPointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>, projectId: string) => {
      setDragProject((currentDragProject) => {
        if (
          !currentDragProject ||
          currentDragProject.projectId !== projectId ||
          currentDragProject.pointerId !== event.pointerId
        ) {
          return currentDragProject;
        }

        const dragOffset = event.clientX - currentDragProject.startX;
        const moved =
          currentDragProject.moved ||
          Math.abs(dragOffset) >= PROJECT_DRAG_THRESHOLD;
        const nextIndex = moved
          ? clamp(
              Math.round(
                (currentDragProject.initialIndex * dragStep + dragOffset) /
                  dragStep,
              ),
              0,
              projects.length - 1,
            )
          : currentDragProject.initialIndex;

        if (
          currentDragProject.currentX === event.clientX &&
          currentDragProject.currentIndex === nextIndex &&
          currentDragProject.moved === moved
        ) {
          return currentDragProject;
        }

        return {
          ...currentDragProject,
          currentIndex: nextIndex,
          currentX: event.clientX,
          moved,
        };
      });
    },
    [dragStep, projects.length],
  );

  const handleProjectPointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>, projectId: string) => {
      finishProjectDrag(projectId, event.pointerId, true, event.currentTarget);
    },
    [finishProjectDrag],
  );

  const handleProjectPointerCancel = useCallback(
    (event: PointerEvent<HTMLButtonElement>, projectId: string) => {
      finishProjectDrag(projectId, event.pointerId, false, event.currentTarget);
    },
    [finishProjectDrag],
  );

  const getProjectTabOffset = useCallback(
    (projectId: string, projectIndex: number) => {
      if (!dragProject || !dragProject.moved) {
        return 0;
      }

      if (projectId === dragProject.projectId) {
        return dragDistance;
      }

      if (
        dragProject.initialIndex < dragProject.currentIndex &&
        projectIndex > dragProject.initialIndex &&
        projectIndex <= dragProject.currentIndex
      ) {
        return -dragStep;
      }

      if (
        dragProject.initialIndex > dragProject.currentIndex &&
        projectIndex >= dragProject.currentIndex &&
        projectIndex < dragProject.initialIndex
      ) {
        return dragStep;
      }

      return 0;
    },
    [dragDistance, dragProject, dragStep],
  );

  return (
    <header
      id="app-titlebar"
      className={cn(
        "flex shrink-0 flex-col bg-background/95 text-foreground backdrop-blur-sm [-webkit-app-region:drag]",
        isMacOs ? "pr-3" : "pr-0",
      )}
    >
      <div className="flex h-11 items-end gap-2 pl-3 [-webkit-app-region:drag]">
        <div
          className={cn(
            "h-8 shrink-0 [-webkit-app-region:drag]",
            isMacOs ? "w-24" : "w-0",
          )}
        />

        <div className="min-w-0 flex-1 pb-0.5 [-webkit-app-region:drag]">
          {appReady ? (
            <div className="flex items-end [-webkit-app-region:drag]">
              <div
                className="min-w-0 w-fit max-w-full overflow-x-auto pb-px [-webkit-app-region:no-drag]"
                ref={projectTabsScrollRef}
              >
                <div className="flex min-w-max items-end gap-1 pr-1 [-webkit-app-region:no-drag]">
                  {projects.map((project, projectIndex) => {
                    const isActive = project.id === activeProjectId;
                    const isDragging =
                      project.id === dragProject?.projectId &&
                      dragProject.moved;
                    const isProjectMenuOpen = openProjectMenuId === project.id;
                    const tabOffset = getProjectTabOffset(
                      project.id,
                      projectIndex,
                    );

                    return (
                      <div
                        className="group relative shrink-0 transition-transform duration-150 ease-out"
                        key={project.id}
                        style={{
                          transform: `translateX(${tabOffset}px)`,
                          width: `${projectTabWidth}px`,
                          zIndex: isDragging ? 10 : 0,
                        }}
                      >
                        <button
                          className={cn(
                            "flex h-8 w-full select-none items-center rounded-lg border px-3 pr-8 text-sm opacity-100 transition-[colors,box-shadow]",
                            isActive
                              ? "border-border bg-background text-foreground shadow-sm"
                              : "border-transparent bg-muted/55 text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                            isDragging && "shadow-md",
                          )}
                          onClick={() => {
                            if (
                              suppressProjectClickRef.current === project.id
                            ) {
                              suppressProjectClickRef.current = null;
                              return;
                            }

                            setActiveProjectId(project.id);
                          }}
                          onPointerCancel={(event) =>
                            handleProjectPointerCancel(event, project.id)
                          }
                          onPointerDown={(event) =>
                            handleProjectPointerDown(
                              event,
                              project.id,
                              projectIndex,
                            )
                          }
                          onPointerMove={(event) =>
                            handleProjectPointerMove(event, project.id)
                          }
                          onPointerUp={(event) =>
                            handleProjectPointerUp(event, project.id)
                          }
                          draggable={false}
                          onDragStart={(event) => {
                            event.preventDefault();
                          }}
                          type="button"
                        >
                          <span className="truncate">{project.name}</span>
                        </button>
                        <div
                          className={cn(
                            "absolute top-1/2 right-0.5 -translate-y-1/2 transition-opacity",
                            isProjectMenuOpen
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100",
                          )}
                        >
                          <DropdownMenu
                            onOpenChange={(open) =>
                              setOpenProjectMenuId(open ? project.id : null)
                            }
                            open={isProjectMenuOpen}
                          >
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  aria-label={`${project.name} actions`}
                                  className="h-8 w-8 p-0 [-webkit-app-region:no-drag]"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                  }}
                                  onPointerDown={(event) => {
                                    event.stopPropagation();
                                  }}
                                  size="icon-sm"
                                  type="button"
                                  variant="ghost"
                                />
                              }
                            >
                              <Ellipsis className="size-4" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                              align="end"
                              className="w-44 [-webkit-app-region:no-drag]"
                            >
                              <DropdownMenuItem
                                onClick={() => {
                                  setRenameTarget({
                                    id: project.id,
                                    name: project.name,
                                  });
                                  setRenameValue(project.name);
                                }}
                              >
                                <FilePenLine className="size-4" />
                                Edit
                              </DropdownMenuItem>
                              {detectedEditors.length > 0 ? (
                                <DropdownMenuSub>
                                  <DropdownMenuSubTrigger>
                                    <ExternalLink className="size-4" />
                                    Open in
                                  </DropdownMenuSubTrigger>
                                  <DropdownMenuSubContent className="[-webkit-app-region:no-drag]">
                                    {detectedEditors.map((editor) => (
                                      <DropdownMenuItem
                                        key={editor.id}
                                        onClick={() => {
                                          const api = getDesktopApi();
                                          if (api) {
                                            void api.openInEditor({
                                              editorId: editor.id,
                                              projectPath: project.path,
                                            });
                                          }
                                        }}
                                      >
                                        {editor.name}
                                      </DropdownMenuItem>
                                    ))}
                                  </DropdownMenuSubContent>
                                </DropdownMenuSub>
                              ) : null}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => closeProject(project.id)}
                              >
                                <X className="size-4" />
                                Close
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    );
                  })}

                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label="Add project"
                          className="mb-px h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                          onClick={() => void handleAddProject()}
                          ref={addProjectButtonRef}
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
              </div>
            </div>
          ) : (
            <div className="pointer-events-none flex h-full items-center justify-center pb-2 [-webkit-app-region:drag]">
              <span className="text-muted-foreground text-xs tracking-widest">
                DREAM
              </span>
            </div>
          )}
        </div>

        {appReady ? (
          <div className="flex items-center gap-1 pb-1 [-webkit-app-region:no-drag]">
            <ToggleButton
              active={panelVisibility.left}
              onClick={() => togglePanel("left")}
              title="Toggle threads panel"
            >
              <PanelLeft className="size-4" />
            </ToggleButton>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open terminal"
                    className={cn(
                      "h-8 w-8 p-0 [-webkit-app-region:no-drag]",
                      terminalHiddenWithActiveSession
                        ? "text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
                        : terminalOpen
                          ? "text-foreground hover:text-foreground"
                          : "text-muted-foreground/50 hover:text-foreground",
                    )}
                    disabled={!activeProject}
                    onClick={handleOpenTerminal}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <TerminalSquare className="size-4 shrink-0" />
              </TooltipTrigger>
              <TooltipContent>Open terminal</TooltipContent>
            </Tooltip>
            <ToggleButton
              active={panelVisibility.right}
              onClick={() => togglePanel("right")}
              title="Toggle right panel"
            >
              <PanelRight className="size-4" />
            </ToggleButton>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Settings"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
                    onClick={handleOpenSettings}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <Settings className="size-4 shrink-0" />
              </TooltipTrigger>
              <TooltipContent>Settings</TooltipContent>
            </Tooltip>
          </div>
        ) : null}

        {!isMacOs && isElectron && appReady ? <WindowControls /> : null}
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
              <DialogTitle>Rename project</DialogTitle>
              <DialogDescription>
                Choose a new name for this project.
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
    </header>
  );
};

const WindowControls = () => {
  const api = getDesktopApi();

  return (
    <div className="flex h-full items-stretch [-webkit-app-region:no-drag]">
      <button
        aria-label="Minimize"
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => api?.windowMinimize()}
        type="button"
      >
        <Minus className="size-3.5" />
      </button>
      <button
        aria-label="Maximize"
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => api?.windowMaximize()}
        type="button"
      >
        <Square className="size-3" />
      </button>
      <button
        aria-label="Close"
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-red-500 hover:text-white"
        onClick={() => api?.windowClose()}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  );
};
