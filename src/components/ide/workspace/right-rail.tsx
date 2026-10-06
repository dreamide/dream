import { Code, Files, Globe, Inbox, TerminalSquare } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo } from "react";
import type { RightPanelView } from "@/types/ide";
import { GitActionsMenu } from "../git-actions-menu";
import { PullRequestNavButton } from "../pull-requests/nav-button";
import { useShortcutTitle } from "../shortcuts/shortcut-keys";
import { WorkspaceNavButton } from "./nav-button";

export interface WorkspaceRightRailProps {
  active: boolean;
  browserHiddenWithActiveTab: boolean;
  changesAvailable: boolean;
  onOpenTerminal: () => void;
  onSelectRightPanelView: (view: RightPanelView) => void;
  projectId: string;
  projectPath: string;
  rightPanelView: RightPanelView;
  rightVisible: boolean;
  stashAvailable: boolean;
  terminalHiddenWithActiveSession: boolean;
}

const WorkspaceRightRailImpl = ({
  active,
  browserHiddenWithActiveTab,
  changesAvailable,
  onOpenTerminal,
  onSelectRightPanelView,
  projectId,
  projectPath,
  rightPanelView,
  rightVisible,
  stashAvailable,
  terminalHiddenWithActiveSession,
}: WorkspaceRightRailProps) => {
  const t = useTranslations("common");
  const changesTitle = useShortcutTitle("showChanges", t("changes"));
  const filesTitle = useShortcutTitle("showFiles", t("files"));
  const browserTitle = useShortcutTitle("showBrowser", t("browser"));
  const terminalTitle = useShortcutTitle("toggleTerminal", t("terminal"));
  const stashTitle = useShortcutTitle("showStash", t("stash"));

  return (
    <aside className="relative z-20 flex w-12 shrink-0 flex-col items-center gap-1 py-2">
      <GitActionsMenu projectId={projectId} projectPath={projectPath} />
      <WorkspaceNavButton
        active={rightVisible && rightPanelView === "changes"}
        accent={changesAvailable}
        onClick={() => onSelectRightPanelView("changes")}
        title={changesTitle}
      >
        <Code className="size-4" />
      </WorkspaceNavButton>
      <WorkspaceNavButton
        active={rightVisible && rightPanelView === "explorer"}
        onClick={() => onSelectRightPanelView("explorer")}
        title={filesTitle}
      >
        <Files className="size-4" />
      </WorkspaceNavButton>
      <WorkspaceNavButton
        active={rightVisible && rightPanelView === "browser"}
        accent={browserHiddenWithActiveTab}
        onClick={() => onSelectRightPanelView("browser")}
        title={browserTitle}
      >
        <Globe className="size-4" />
      </WorkspaceNavButton>
      <WorkspaceNavButton
        aria-label={t("terminal")}
        active={rightVisible && rightPanelView === "terminal"}
        accent={terminalHiddenWithActiveSession}
        onClick={onOpenTerminal}
        title={terminalTitle}
      >
        <TerminalSquare className="size-4" />
      </WorkspaceNavButton>
      <PullRequestNavButton
        visible={active}
        projectPath={projectPath}
        active={rightVisible && rightPanelView === "pull-requests"}
        onClick={() => onSelectRightPanelView("pull-requests")}
      />
      <WorkspaceNavButton
        active={rightVisible && rightPanelView === "stash"}
        accent={stashAvailable}
        className="mt-auto"
        onClick={() => onSelectRightPanelView("stash")}
        title={stashTitle}
      >
        <Inbox className="size-4" />
      </WorkspaceNavButton>
    </aside>
  );
};

export const WorkspaceRightRail = memo(WorkspaceRightRailImpl);
WorkspaceRightRail.displayName = "WorkspaceRightRail";
