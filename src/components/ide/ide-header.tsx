import {
  Folder,
  GitCompareArrows,
  MessageSquare,
  Minus,
  Monitor,
  PanelLeft,
  PanelRight,
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
  const togglePanel = useIdeStore((s) => s.togglePanel);
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);

  const handleOpenSettings = useCallback(() => {
    setSettingsSection("appearance");
    setSettingsOpen(true);
  }, [setSettingsOpen, setSettingsSection]);

  return (
    <header
      id="app-titlebar"
      className={cn(
        "relative flex h-11 items-center pl-3 text-foreground [-webkit-app-region:drag]",
        isMacOs && "pr-3",
      )}
    >
      <div className={cn("h-8 shrink-0", isMacOs ? "w-24" : "w-0")} />

      {appReady ? (
        <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
          <ToggleButton
            active={panelVisibility.left}
            onClick={() => togglePanel("left")}
            title="Toggle projects panel"
          >
            <PanelLeft className="size-4" />
          </ToggleButton>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Settings"
                  className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
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

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="text-muted-foreground text-xs tracking-widest">
          DREAM
        </span>
      </div>

      {appReady ? (
        <div className="ml-auto flex items-center gap-1 [-webkit-app-region:no-drag]">
          <ToggleButton
            active={panelVisibility.middle}
            onClick={() => togglePanel("middle")}
            title="Toggle chat panel"
          >
            <MessageSquare className="size-4" />
          </ToggleButton>
          <ToggleButton
            active={panelVisibility.right}
            onClick={() => togglePanel("right")}
            title="Toggle right panel"
          >
            <PanelRight className="size-4" />
          </ToggleButton>
        </div>
      ) : null}

      {!isMacOs && isElectron && appReady ? <WindowControls /> : null}
    </header>
  );
};

export const IdeFooter = () => {
  const appReady = useIdeStore((s) => s.appReady);
  const activeProject = useIdeStore((s) => s.getActiveProject());
  const panelVisibility = useIdeStore((s) => s.panelVisibility);
  const projectTerminalSessionIds = useIdeStore(
    (s) => s.projectTerminalSessionIds,
  );
  const openProjectTerminal = useIdeStore((s) => s.openProjectTerminal);
  const rightPanelView = useIdeStore((s) => s.rightPanelView);
  const setRightPanelView = useIdeStore((s) => s.setRightPanelView);

  const terminalOpen = activeProject
    ? (projectTerminalSessionIds[activeProject.id]?.length ?? 0) > 0
    : false;

  const handleOpenTerminal = useCallback(() => {
    if (!activeProject) {
      return;
    }

    if (!useIdeStore.getState().panelVisibility.middle) {
      useIdeStore.setState((state) => ({
        panelVisibility: {
          ...state.panelVisibility,
          middle: true,
        },
      }));
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
    <footer className="relative flex h-11 items-center justify-between pl-3 pr-3 text-foreground">
      <div className="flex items-center [-webkit-app-region:no-drag]">
        {appReady ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Open terminal"
                  className={cn(
                    "h-8 w-8 p-0",
                    terminalOpen
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
        ) : null}
      </div>

      {appReady && panelVisibility.right ? (
        <Tabs
          className="ml-auto"
          onValueChange={handleRightPanelViewChange}
          value={rightPanelView}
        >
          <TabsList className="h-8 bg-muted/60">
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
    </footer>
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
