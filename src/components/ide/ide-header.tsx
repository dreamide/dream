import { cn } from "@/lib/utils";
import { ProjectTabs } from "./header/project-tabs";
import { WindowControls } from "./header/window-controls";
import { useIdeStore } from "./ide-store";

export const IdeHeader = () => {
  const appReady = useIdeStore((s) => s.appReady);
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const isElectron = useIdeStore((s) => s.isElectron);

  return (
    <header
      id="app-titlebar"
      className="flex shrink-0 flex-col text-foreground [-webkit-app-region:drag]"
    >
      <div className="flex h-12 items-center gap-2 [-webkit-app-region:drag]">
        <div
          className={cn(
            "h-8 shrink-0 [-webkit-app-region:drag]",
            isMacOs ? "w-24" : "w-0",
          )}
        />

        <ProjectTabs />

        {!isMacOs && isElectron && appReady ? <WindowControls /> : null}
      </div>
    </header>
  );
};
