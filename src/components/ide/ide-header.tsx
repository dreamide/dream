import {
  Folder,
  GitCompareArrows,
  Minus,
  Monitor,
  PanelLeft,
  PanelRight,
  Plus,
  Settings,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";

import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";

import { ToggleButton } from "./ide-helpers";
import { useIdeStore } from "./ide-store";

export const IdeHeader = () => {
  const appReady = useIdeStore((s) => s.appReady);
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const isElectron = useIdeStore((s) => s.isElectron);
  const panelVisibility = useIdeStore((s) => s.panelVisibility);
  const rightPanelView = useIdeStore((s) => s.rightPanelView);
  const projects = useIdeStore((s) => s.projects);
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const togglePanel = useIdeStore((s) => s.togglePanel);
  const setRightPanelView = useIdeStore((s) => s.setRightPanelView);
  const setActiveProjectId = useIdeStore((s) => s.setActiveProjectId);
  const closeProject = useIdeStore((s) => s.closeProject);
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
  const terminalOpen = activeProject
    ? (projectTerminalSessionIds[activeProject.id]?.length ?? 0) > 0
    : false;
  const terminalHiddenWithActiveSession =
    terminalOpen && !projectTerminalPanelOpen;

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

  const handleRightPanelViewChange = useCallback(
    (value: string) => {
      if (value !== "preview" && value !== "explorer" && value !== "changes") {
        return;
      }

      setRightPanelView(value);
    },
    [setRightPanelView],
  );

  return (
    <header
      id="app-titlebar"
      className={cn(
        "flex shrink-0 flex-col bg-background/95 text-foreground backdrop-blur-sm [-webkit-app-region:drag]",
        isMacOs ? "pr-3" : "pr-0",
      )}
    >
      <div className="flex h-11 items-end gap-2 pl-3">
        <div className={cn("h-8 shrink-0", isMacOs ? "w-24" : "w-0")} />

        <div className="min-w-0 flex-1 pb-0.5">
          {appReady ? (
            <div className="flex items-end">
              <div className="min-w-0 flex-1 overflow-x-auto pb-px">
                <div className="flex min-w-max items-end gap-1 pr-1">
                  {projects.map((project) => {
                    const isActive = project.id === activeProjectId;

                    return (
                      <div className="group relative" key={project.id}>
                        <button
                          className={cn(
                            "flex h-8 max-w-64 items-center rounded-lg border px-3 pr-8 text-sm transition-colors [-webkit-app-region:no-drag]",
                            isActive
                              ? "border-border bg-background text-foreground shadow-sm"
                              : "border-transparent bg-muted/55 text-muted-foreground hover:bg-muted/80 hover:text-foreground",
                          )}
                          onClick={() => setActiveProjectId(project.id)}
                          type="button"
                        >
                          <span className="truncate">{project.name}</span>
                        </button>
                        <button
                          className={cn(
                            "absolute top-1/2 right-2 flex size-4 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground [-webkit-app-region:no-drag]",
                            isActive
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100",
                          )}
                          aria-label={`Close ${project.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            closeProject(project.id);
                          }}
                          type="button"
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    );
                  })}

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
                </div>
              </div>
            </div>
          ) : (
            <div className="pointer-events-none flex h-full items-center justify-center pb-2">
              <span className="text-muted-foreground text-xs tracking-widest">
                DREAM
              </span>
            </div>
          )}
        </div>

        {appReady ? (
          <div className="flex items-center gap-1 pb-1">
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

      {appReady ? (
        <div className="flex h-11 items-center gap-1 px-3">
          <div className="ml-auto flex items-center gap-2 [-webkit-app-region:no-drag]">
            {panelVisibility.right ? (
              <Tabs
                onValueChange={handleRightPanelViewChange}
                value={rightPanelView}
              >
                <TabsList className="h-8 bg-muted/60">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <TabsTrigger
                          aria-label="Show changes"
                          className="h-6 w-8 px-0 data-[active]:bg-background"
                          value="changes"
                        />
                      }
                    >
                      <GitCompareArrows className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>Changes</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <TabsTrigger
                          aria-label="Show file explorer"
                          className="h-6 w-8 px-0 data-[active]:bg-background"
                          value="explorer"
                        />
                      }
                    >
                      <Folder className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>Files</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <TabsTrigger
                          aria-label="Show preview"
                          className="h-6 w-8 px-0 data-[active]:bg-background"
                          value="preview"
                        />
                      }
                    >
                      <Monitor className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>Preview</TooltipContent>
                  </Tooltip>
                </TabsList>
              </Tabs>
            ) : null}
          </div>
        </div>
      ) : null}
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
