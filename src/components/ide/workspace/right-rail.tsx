import { Files, Globe, Inbox, TerminalSquare } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo } from "react";
import { hasDesktopApi } from "@/lib/electron";
import type { RightPanelView } from "@/types/ide";
import { GitNavButton } from "../git-panel/nav-button";
import { useShortcutTitle } from "../shortcuts/shortcut-keys";
import { WorkspaceNavButton } from "./nav-button";

export interface WorkspaceRightRailProps {
  active: boolean;
  browserHiddenWithActiveTab: boolean;
  onOpenTerminal: () => void;
  onSelectRightPanelView: (view: RightPanelView) => void;
  projectId: string;
  projectPath: string;
  rightPanelView: RightPanelView;
  rightVisible: boolean;
  /** Not for a standalone chat, whose folder is never a repository. */
  showGit: boolean;
  stashAvailable: boolean;
  terminalHiddenWithActiveSession: boolean;
}

const WorkspaceRightRailImpl = ({
  active,
  browserHiddenWithActiveTab,
  onOpenTerminal,
  onSelectRightPanelView,
  projectId,
  projectPath,
  rightPanelView,
  rightVisible,
  showGit,
  stashAvailable,
  terminalHiddenWithActiveSession,
}: WorkspaceRightRailProps) => {
  const t = useTranslations("common");
  const filesTitle = useShortcutTitle("showFiles", t("files"));
  const browserTitle = useShortcutTitle("showBrowser", t("browser"));
  const terminalTitle = useShortcutTitle("toggleTerminal", t("terminal"));
  const stashTitle = useShortcutTitle("showStash", t("stash"));

  return (
    <aside className="relative z-20 flex w-12 shrink-0 flex-col items-center gap-1 py-2">
      {showGit ? (
        <GitNavButton
          active={rightVisible && rightPanelView === "git"}
          onClick={() => onSelectRightPanelView("git")}
          projectId={projectId}
          projectPath={projectPath}
          visible={active}
        />
      ) : null}
      <WorkspaceNavButton
        active={rightVisible && rightPanelView === "explorer"}
        onClick={() => onSelectRightPanelView("explorer")}
        title={filesTitle}
      >
        <Files className="size-4" />
      </WorkspaceNavButton>
      {/* The webview browser is the desktop window's. */}
      {hasDesktopApi() ? (
        <WorkspaceNavButton
          active={rightVisible && rightPanelView === "browser"}
          accent={browserHiddenWithActiveTab}
          onClick={() => onSelectRightPanelView("browser")}
          title={browserTitle}
        >
          <Globe className="size-4" />
        </WorkspaceNavButton>
      ) : null}
      <WorkspaceNavButton
        aria-label={t("terminal")}
        active={rightVisible && rightPanelView === "terminal"}
        accent={terminalHiddenWithActiveSession}
        onClick={onOpenTerminal}
        title={terminalTitle}
      >
        <TerminalSquare className="size-4" />
      </WorkspaceNavButton>
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
