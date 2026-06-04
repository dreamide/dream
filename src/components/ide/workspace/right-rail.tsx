import { Code, Files, Globe, TerminalSquare } from "lucide-react";
import { memo } from "react";
import type { RightPanelView } from "@/types/ide";
import { GitActionsMenu } from "../git-actions-menu";
import { WorkspaceNavButton } from "./nav-button";

export interface WorkspaceRightRailProps {
  browserHiddenWithActiveTab: boolean;
  changesAvailable: boolean;
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
  changesAvailable,
  onOpenTerminal,
  onSelectRightPanelView,
  projectId,
  projectPath,
  rightPanelView,
  rightVisible,
  terminalHiddenWithActiveSession,
}: WorkspaceRightRailProps) => (
  <aside className="relative z-20 flex w-12 shrink-0 flex-col items-center gap-1 py-2">
    <WorkspaceNavButton
      active={rightVisible && rightPanelView === "changes"}
      accent={changesAvailable}
      onClick={() => onSelectRightPanelView("changes")}
      title="Changes"
    >
      <Code className="size-4" />
    </WorkspaceNavButton>
    <WorkspaceNavButton
      active={rightVisible && rightPanelView === "explorer"}
      onClick={() => onSelectRightPanelView("explorer")}
      title="Files"
    >
      <Files className="size-4" />
    </WorkspaceNavButton>
    <WorkspaceNavButton
      active={rightVisible && rightPanelView === "browser"}
      accent={browserHiddenWithActiveTab}
      onClick={() => onSelectRightPanelView("browser")}
      title="Browser"
    >
      <Globe className="size-4" />
    </WorkspaceNavButton>
    <WorkspaceNavButton
      aria-label="Terminal"
      active={rightVisible && rightPanelView === "terminal"}
      accent={terminalHiddenWithActiveSession}
      onClick={onOpenTerminal}
      title="Terminal"
    >
      <TerminalSquare className="size-4" />
    </WorkspaceNavButton>
    <GitActionsMenu projectId={projectId} projectPath={projectPath} />
  </aside>
);

export const WorkspaceRightRail = memo(WorkspaceRightRailImpl);
WorkspaceRightRail.displayName = "WorkspaceRightRail";
