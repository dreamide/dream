import {
  FolderPlus,
  MessageSquare,
  Minus,
  PanelLeft,
  PanelRight,
  Settings,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getDesktopApi } from "@/lib/electron";
import { ToggleButton } from "./ide-helpers";
import { useIdeStore } from "./ide-store";

export const IdeHeader = () => {
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const panelVisibility = useIdeStore((s) => s.panelVisibility);
  const togglePanel = useIdeStore((s) => s.togglePanel);
  const addProject = useIdeStore((s) => s.addProject);
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);
  const terminalPanelOpen = useIdeStore((s) => s.terminalPanelOpen);
  const setTerminalPanelOpen = useIdeStore((s) => s.setTerminalPanelOpen);
  const activeProject = useIdeStore((s) => s.getActiveProject());

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
    <header className={cn("relative flex h-11 items-center border-b bg-background pl-3 text-foreground [-webkit-app-region:drag]", isMacOs && "pr-3")}>
      <div className={cn("h-8 shrink-0", isMacOs ? "w-24" : "w-2")} />

      <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
        <Button
          aria-label="Add project"
          className="size-8"
          onClick={() => void handleAddProject()}
          size="icon"
          title="Add project"
          variant="ghost"
        >
          <FolderPlus className="size-4" />
        </Button>
        <Button
          aria-label="Settings"
          className="size-8"
          onClick={handleOpenSettings}
          size="icon"
          title="Settings"
          variant="ghost"
        >
          <Settings className="size-4" />
        </Button>
        <ToggleButton
          active={terminalPanelOpen}
          disabled={!activeProject}
          onClick={() => setTerminalPanelOpen(!terminalPanelOpen)}
          title="Toggle terminal"
        >
          <TerminalSquare className="size-4" />
        </ToggleButton>
      </div>

      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span className="text-muted-foreground text-xs tracking-wide">
          DREAM
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1 [-webkit-app-region:no-drag]">
        <ToggleButton
          active={panelVisibility.left}
          onClick={() => togglePanel("left")}
          title="Toggle projects panel"
        >
          <PanelLeft className="size-4" />
        </ToggleButton>
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
          title="Toggle preview panel"
        >
          <PanelRight className="size-4" />
        </ToggleButton>
      </div>

      {!isMacOs && <WindowControls />}
    </header>
  );
};

const WindowControls = () => {
  const api = getDesktopApi();
  if (!api) return null;

  return (
    <div className="flex h-full items-stretch [-webkit-app-region:no-drag]">
      <button
        aria-label="Minimize"
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={() => api.windowMinimize()}
        type="button"
      >
        <Minus className="size-3.5" />
      </button>
      <button
        aria-label="Maximize"
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={() => api.windowMaximize()}
        type="button"
      >
        <Square className="size-3" />
      </button>
      <button
        aria-label="Close"
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-red-500 hover:text-white"
        onClick={() => api.windowClose()}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  );
};
