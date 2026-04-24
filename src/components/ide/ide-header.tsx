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
import {
  moveTabItem,
  type StandardTabItem,
  StandardTabs,
} from "./standard-tabs";

type RenameTarget = {
  id: string;
  name: string;
};

type ProjectTabItem = StandardTabItem & {
  completed: boolean;
  path: string;
  streaming: boolean;
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
  const [detectedEditors, setDetectedEditors] = useState<DetectedEditor[]>([]);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(
    null,
  );
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
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
  const desktopApi = getDesktopApi();
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

  const handleOpenProjectInEditor = useCallback(
    async (
      project: {
        path: string;
      },
      editorId: string,
    ) => {
      if (!desktopApi) {
        return;
      }

      await desktopApi.openInEditor({
        editorId,
        projectPath: project.path,
      });
    },
    [desktopApi],
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

  const projectTabItems = useMemo<ProjectTabItem[]>(
    () =>
      projects.map((project) => ({
        completed: Boolean(completedProjectIds[project.id]),
        id: project.id,
        label: project.name,
        leading:
          completedProjectIds[project.id] && project.id !== activeProjectId ? (
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full bg-green-500"
            />
          ) : null,
        path: project.path,
        streaming: streamingProjectIds.has(project.id),
      })),
    [activeProjectId, completedProjectIds, projects, streamingProjectIds],
  );

  const handleProjectReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      setProjects(moveTabItem(projects, fromIndex, toIndex));
    },
    [projects, setProjects],
  );

  return (
    <header
      id="app-titlebar"
      className={cn(
        "flex shrink-0 flex-col border-b border-foreground/10 bg-muted/70 text-foreground backdrop-blur-sm [-webkit-app-region:drag]",
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
            <StandardTabs
              activeId={activeProjectId}
              after={
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="Add project"
                        className="mb-px h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
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
              }
              ariaLabel="Projects"
              interactiveClassName="[-webkit-app-region:no-drag]"
              items={projectTabItems}
              onActivate={setActiveProjectId}
              onReorder={handleProjectReorder}
              renderActions={(project) => {
                const isProjectMenuOpen = openProjectMenuId === project.id;

                return (
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
                            aria-label={`${project.label} actions`}
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
                              name: project.label,
                            });
                            setRenameValue(project.label);
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
                                  onClick={() =>
                                    void handleOpenProjectInEditor(
                                      project,
                                      editor.id,
                                    )
                                  }
                                >
                                  {editor.id === "vscode" ? (
                                    <VscodeMark />
                                  ) : editor.isFileExplorer ? (
                                    <FolderOpen className="size-4" />
                                  ) : editor.isTerminal ? (
                                    isMacOs ? (
                                      <TerminalSquare className="size-4" />
                                    ) : (
                                      <PowerShellMark />
                                    )
                                  ) : (
                                    <ExternalLink className="size-4" />
                                  )}
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
                );
              }}
              renderFrame={(project, tab) => (
                <Sparkles
                  className="w-full overflow-hidden"
                  density={38}
                  disabled={!project.streaming}
                  groundGlow={true}
                  height={10}
                  palette={["#9bf2ff", "#6ac7ff", "#caf8ff", "#5ea3ff"]}
                  position="bottom"
                  sizeMul={0.5}
                  speed={3}
                  style={{ position: "relative" }}
                  sway={0}
                >
                  {tab}
                </Sparkles>
              )}
            />
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
            <Tooltip>
              <Popover onOpenChange={setHistoryOpen} open={historyOpen}>
                <PopoverTrigger
                  render={
                    <TooltipTrigger
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
                          variant="ghost"
                        />
                      }
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
              <TooltipContent>Chat history</TooltipContent>
            </Tooltip>
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
