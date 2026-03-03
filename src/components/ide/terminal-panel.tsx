import { TerminalSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIdeStore } from "./ide-store";
import { GLOBAL_TERMINAL_SESSION_ID, TERMINAL_MIN_HEIGHT_PX } from "./ide-types";

export interface TerminalPanelProps {
  terminalHostRef: (el: HTMLDivElement | null) => void;
}

export const TerminalPanel = ({ terminalHostRef }: TerminalPanelProps) => {
  const settings = useIdeStore((s) => s.settings);
  const terminalShell = useIdeStore((s) => s.terminalShell);
  const stopActiveTerminal = useIdeStore((s) => s.stopActiveTerminal);
  const setTerminalPanelOpen = useIdeStore((s) => s.setTerminalPanelOpen);

  const activeTerminalShell =
    terminalShell[GLOBAL_TERMINAL_SESSION_ID] ||
    settings.shellPath.trim() ||
    "system shell";

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={{ minHeight: TERMINAL_MIN_HEIGHT_PX }}
    >
      <div className="flex items-center justify-between px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <TerminalSquare className="size-4" />
          <span>Terminal</span>
          <span className="text-muted-foreground">{activeTerminalShell}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            aria-label="Close terminal panel"
            className="h-7 w-7 p-0"
            onClick={() => {
              setTerminalPanelOpen(false);
              void stopActiveTerminal();
            }}
            size="sm"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-background p-2">
        <div className="h-full w-full" ref={terminalHostRef} />
      </div>
    </div>
  );
};
