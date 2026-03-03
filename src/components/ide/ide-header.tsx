import { MessageSquare, PanelLeft, PanelRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToggleButton } from "./ide-helpers";
import { useIdeStore } from "./ide-store";

export const IdeHeader = () => {
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const panelVisibility = useIdeStore((s) => s.panelVisibility);
  const togglePanel = useIdeStore((s) => s.togglePanel);

  return (
    <header className="relative flex h-11 items-center border-b bg-background px-3 text-foreground [-webkit-app-region:drag]">
      <div className={cn("h-8 shrink-0", isMacOs ? "w-24" : "w-2")} />

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
    </header>
  );
};
