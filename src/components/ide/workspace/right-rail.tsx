import { Code, Files, Globe, TerminalSquare } from "lucide-react";
import { memo } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { RightPanelView } from "@/types/ide";
import { GitActionsMenu } from "../git-actions-menu";
import { ToggleButton } from "../ide-helpers";

export interface WorkspaceRightRailProps {
  browserHiddenWithActiveTab: boolean;
  onOpenTerminal: () => void;
  onSelectRightPanelView: (view: RightPanelView) => void;
  projectId: string;
  projectPath: string;
  rightPanelView: RightPanelView;
  rightVisible: boolean;
  terminalHiddenWithActiveSession: boolean;
}

const WorkspaceRightRailImpl = ({
  browserHiddenWithActiveTab,
  onOpenTerminal,
  onSelectRightPanelView,
  projectId,
  projectPath,
  rightPanelView,
  rightVisible,
  terminalHiddenWithActiveSession,
}: WorkspaceRightRailProps) => (
  <aside className="relative z-20 flex w-12 shrink-0 flex-col items-center gap-1 py-2">
    <ToggleButton
      active={rightVisible && rightPanelView === "changes"}
      onClick={() => onSelectRightPanelView("changes")}
      title="Changes"
    >
      <Code className="size-4" />
    </ToggleButton>
    <ToggleButton
      active={rightVisible && rightPanelView === "explorer"}
      onClick={() => onSelectRightPanelView("explorer")}
      title="Files"
    >
      <Files className="size-4" />
    </ToggleButton>
    <ToggleButton
      active={rightVisible && rightPanelView === "browser"}
      highlighted={browserHiddenWithActiveTab}
      onClick={() => onSelectRightPanelView("browser")}
      title="Browser"
    >
      <Globe className="size-4" />
    </ToggleButton>
    <Button
      aria-label="Terminal"
      className={cn(
        "size-8",
        rightVisible && rightPanelView === "terminal"
          ? "bg-primary-surface text-primary hover:bg-primary-surface-hover hover:text-primary"
          : terminalHiddenWithActiveSession
            ? "text-primary hover:text-primary-hover"
            : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onOpenTerminal}
      size="icon"
      title="Terminal"
      variant="ghost"
    >
      <TerminalSquare className="size-4" />
    </Button>
    <GitActionsMenu projectId={projectId} projectPath={projectPath} />
  </aside>
);

export const WorkspaceRightRail = memo(WorkspaceRightRailImpl);
WorkspaceRightRail.displayName = "WorkspaceRightRail";
