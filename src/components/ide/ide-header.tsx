import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ProjectTabs } from "./header/project-tabs";
import { WindowControls } from "./header/window-controls";
import { useIdeStore } from "./ide-store";

export const IdeHeader = () => {
  const appReady = useIdeStore((s) => s.appReady);
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const isElectron = useIdeStore((s) => s.isElectron);
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);

  const openSettings = () => {
    setSettingsSection("appearance");
    setSettingsOpen(true);
  };

  return (
    <header
      id="app-titlebar"
      className={cn(
        "flex shrink-0 flex-col text-foreground [-webkit-app-region:drag]",
        isMacOs ? "pr-3" : "pr-0",
      )}
    >
      <div className="flex h-12 items-center gap-2 [-webkit-app-region:drag]">
        <div
          className={cn(
            "h-8 shrink-0 [-webkit-app-region:drag]",
            isMacOs ? "w-24" : "w-0",
          )}
        />

        <ProjectTabs />

        {appReady ? (
          <Button
            aria-label="Settings"
            className="mr-1 size-8 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
            onClick={openSettings}
            size="icon"
            title="Settings"
            variant="ghost"
          >
            <Settings className="size-4" />
          </Button>
        ) : null}

        {!isMacOs && isElectron && appReady ? <WindowControls /> : null}
      </div>
    </header>
  );
};
