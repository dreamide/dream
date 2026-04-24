import {
  Ellipsis,
  ExternalLink,
  FilePenLine,
  FolderOpen,
  History,
  MessageSquarePlus,
  Minus,
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
  useMemo,
  useRef,
  useState,
} from "react";
import powershellIcon from "@/assets/powershell.svg";
import vscodeIcon from "@/assets/vscode.svg";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import Sparkles from "@/components/ui/sparkles";
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
import { ProjectSidebar } from "./projects-panel";

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

type OpenInTarget = "file-explorer" | "terminal" | "vscode";

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

const VscodeMark = ({ className }: { className?: string }) => (
  <img
    alt=""
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    src={vscodeIcon}
  />
);

const PowerShellMark = ({ className }: { className?: string }) => (
  <img
    alt=""
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    src={powershellIcon}
  />
);

export const IdeHeader = () => {
  const appReady = useIdeStore((s) => s.appReady);
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const isElectron = useIdeStore((s) => s.isElectron);
  const panelVisibility = useIdeStore((s) => s.panelVisibility);
  const projects = useIdeStore((s) => s.projects);
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const togglePanel = useIdeStore((s) => s.togglePanel);
  const addChat = useIdeStore((s) => s.addChat);
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
  const chats = useIdeStore((s) => s.chats);
  const streamingChatIds = useIdeStore((s) => s.streamingChatIds);
  const streamingProjectIds = useMemo(
    () =>
      new Set(
        chats
          .filter((chat) => streamingChatIds[chat.id])
          .map((chat) => chat.projectId),
      ),
    [chats, streamingChatIds],
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
  const [completedProjectIds, setCompletedProjectIds] = useState<
    Record<string, boolean>
  >({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const previousStreamingProjectIdsRef = useRef<Set<string>>(new Set());
  const terminalOpen = activeProject
    ? (projectTerminalSessionIds[activeProject.id]?.length ?? 0) > 0
    : false;
  const terminalHiddenWithActiveSession =
    terminalOpen && !projectTerminalPanelOpen;
  const dragDistance = dragProject
    ? dragProject.currentX - dragProject.startX
    : 0;
  const dragStep = projectTabWidth + PROJECT_TAB_GAP;
  const desktopApi = getDesktopApi();
  const fileExplorerEditor = useMemo(
    () => detectedEditors.find((editor) => editor.isFileExplorer) ?? null,
    [detectedEditors],
  );

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

  const handleOpenProjectInTarget = useCallback(
    async (
      project: {
        path: string;
      },
      target: OpenInTarget,
    ) => {
      if (!desktopApi) {
        return;
      }

      const editorId =
        target === "vscode"
          ? "vscode"
          : target === "terminal"
            ? "terminal"
            : (fileExplorerEditor?.id ?? "file-explorer");

      if (!editorId) {
        return;
      }

      await desktopApi.openInEditor({
        editorId,
        projectPath: project.path,
      });
    },
    [desktopApi, fileExplorerEditor],
  );

  const handleAddChat = useCallback(() => {
    if (!activeProject) {
      return;
    }

    addChat(activeProject.id);
  }, [activeProject, addChat]);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api) {
      return;
    }

    void api.detectEditors().then(setDetectedEditors);
  }, []);

  useEffect(() => {
    const previousStreamingProjectIds = previousStreamingProjectIdsRef.current;

    setCompletedProjectIds((current) => {
      let changed = false;
      const next = { ...current };

      for (const projectId of previousStreamingProjectIds) {
        if (
          !streamingProjectIds.has(projectId) &&
          projectId !== activeProjectId &&
          !next[projectId]
        ) {
          next[projectId] = true;
          changed = true;
        }
      }

      for (const projectId of streamingProjectIds) {
        if (next[projectId]) {
          delete next[projectId];
          changed = true;
        }
      }

      if (activeProjectId && next[activeProjectId]) {
        delete next[activeProjectId];
        changed = true;
      }

      return changed ? next : current;
    });

    previousStreamingProjectIdsRef.current = new Set(streamingProjectIds);
  }, [activeProjectId, streamingProjectIds]);

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
        "flex shrink-0 flex-col bg-muted/70 text-foreground backdrop-blur-sm [-webkit-app-region:drag]",
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
            <div
              className="inline-flex max-w-full items-end gap-1 [-webkit-app-region:drag]"
              ref={projectTabsScrollRef}
            >
              <div className="min-w-0 overflow-hidden pb-px [-webkit-app-region:no-drag]">
                <div className="flex min-w-0 items-end gap-1 [-webkit-app-region:no-drag]">
                  {projects.map((project, projectIndex) => {
                    const isActive = project.id === activeProjectId;
                    const nextProject = projects[projectIndex + 1] ?? null;
                    const isDragging =
                      project.id === dragProject?.projectId &&
                      dragProject.moved;
                    const isProjectMenuOpen = openProjectMenuId === project.id;
                    const isStreaming = streamingProjectIds.has(project.id);
                    const showCompletedDot =
                      completedProjectIds[project.id] && !isActive;
                    const showTrailingSplitter =
                      !isActive &&
                      nextProject !== null &&
                      nextProject.id !== activeProjectId;
                    const tabOffset = getProjectTabOffset(
                      project.id,
                      projectIndex,
                    );
                    const projectTabButton = (
                      <button
                        className={cn(
                          "flex h-8 w-full select-none items-center gap-2 rounded-lg border px-3 pr-8 text-sm opacity-100 transition-[colors,box-shadow]",
                          isActive
                            ? "border-border bg-background text-foreground shadow-sm"
                            : "border-transparent bg-muted/55 text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                          isDragging && "shadow-md",
                        )}
                        onClick={() => {
                          if (suppressProjectClickRef.current === project.id) {
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
                        {showCompletedDot ? (
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full bg-green-500"
                          />
                        ) : null}
                        <span className="truncate">{project.name}</span>
                      </button>
                    );

                    return (
                      <div
                        className="group relative shrink-0 overflow-visible transition-transform duration-150 ease-out"
                        key={project.id}
                        style={{
                          transform: `translateX(${tabOffset}px)`,
                          width: `${projectTabWidth}px`,
                          zIndex: isDragging ? 10 : 0,
                        }}
                      >
                        <Sparkles
                          className="w-full overflow-hidden"
                          density={38}
                          disabled={!isStreaming}
                          groundGlow={true}
                          height={10}
                          sway={0}
                          speed={3}
                          sizeMul={0.5}
                          palette={["#9bf2ff", "#6ac7ff", "#caf8ff", "#5ea3ff"]}
                          style={{ position: "relative" }}
                          position="bottom"
                        >
                          {projectTabButton}
                        </Sparkles>
                        {showTrailingSplitter ? (
                          <div
                            aria-hidden="true"
                            className="pointer-events-none absolute top-1/2 right-[-2.5px] h-4 w-px -translate-y-1/2 bg-foreground/20"
                          />
                        ) : null}
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
                              {desktopApi ? (
                                <DropdownMenuSub>
                                  <DropdownMenuSubTrigger>
                                    <ExternalLink className="size-4" />
                                    Open in
                                  </DropdownMenuSubTrigger>
                                  <DropdownMenuSubContent className="[-webkit-app-region:no-drag]">
                                    <DropdownMenuItem
                                      onClick={() =>
                                        void handleOpenProjectInTarget(
                                          project,
                                          "file-explorer",
                                        )
                                      }
                                    >
                                      <FolderOpen className="size-4" />
                                      {fileExplorerEditor?.name ??
                                        (isMacOs ? "Finder" : "File Explorer")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() =>
                                        void handleOpenProjectInTarget(
                                          project,
                                          "vscode",
                                        )
                                      }
                                    >
                                      <VscodeMark />
                                      VS Code
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() =>
                                        void handleOpenProjectInTarget(
                                          project,
                                          "terminal",
                                        )
                                      }
                                    >
                                      {isMacOs ? (
                                        <TerminalSquare className="size-4" />
                                      ) : (
                                        <PowerShellMark />
                                      )}
                                      {isMacOs ? "Terminal" : "PowerShell"}
                                    </DropdownMenuItem>
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
                </div>
              </div>

              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Add project"
                      className="mb-px h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
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
          ) : null}
        </div>

        {!isMacOs && isElectron && appReady ? <WindowControls /> : null}
      </div>

      {appReady ? (
        <div className="flex items-center gap-2 px-3 pb-1 [-webkit-app-region:drag]">
          <div
            className={cn(
              "shrink-0 [-webkit-app-region:drag]",
              isMacOs ? "w-24" : "w-0",
            )}
          />
          <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
            <Popover onOpenChange={setHistoryOpen} open={historyOpen}>
              <PopoverTrigger
                render={
                  <Button
                    aria-label="Chat history"
                    className={cn(
                      "size-8 [-webkit-app-region:no-drag]",
                      historyOpen
                        ? "text-foreground hover:text-foreground"
                        : "text-muted-foreground/50 hover:text-foreground",
                    )}
                    size="icon"
                    title="Chat history"
                    variant="ghost"
                  />
                }
              >
                <History className="size-4" />
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="h-[min(520px,calc(100vh-96px))] w-[264px] gap-0 overflow-hidden rounded-lg p-0 data-closed:animate-none data-open:animate-none"
                side="bottom"
                sideOffset={6}
              >
                <ProjectSidebar
                  className="rounded-none border-0 shadow-none"
                  onChatSelect={() => setHistoryOpen(false)}
                />
              </PopoverContent>
            </Popover>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="New chat"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
                    disabled={!activeProject}
                    onClick={handleAddChat}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <MessageSquarePlus className="size-4 shrink-0" />
              </TooltipTrigger>
              <TooltipContent>New chat</TooltipContent>
            </Tooltip>
          </div>
          <div className="min-w-0 flex-1" />
          <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
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
        </div>
      ) : null}

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
