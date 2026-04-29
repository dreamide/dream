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
      className={cn(
        "flex shrink-0 flex-col border-b border-foreground/10 bg-muted/70 text-foreground backdrop-blur-sm [-webkit-app-region:drag]",
        isMacOs ? "pr-3" : "pr-0",
      )}
    >
      <div className="flex h-11 items-center gap-2 bg-[oklch(0.945_0_0)] pl-3 shadow-[inset_0_-1px_rgb(0_0_0/0.08)] dark:bg-[oklch(0.245_0_0)] [-webkit-app-region:drag]">
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
