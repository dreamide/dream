import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { hasDesktopApi } from "@/lib/electron";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type { ProjectConfig } from "@/types/ide";
import type { RightPanelView } from "./ide-types";
import { useHostAway } from "./ssh/host-away-notice";

const GitPanel = lazy(() =>
  import("./git-panel/panel").then((module) => ({
    default: module.GitPanel,
  })),
);

const BrowserPanel = lazy(() =>
  import("./browser-panel").then((module) => ({
    default: module.BrowserPanel,
  })),
);
const FileExplorerPanel = lazy(() =>
  import("./file-explorer-panel").then((module) => ({
    default: module.FileExplorerPanel,
  })),
);
const ProjectTerminalTabsPanel = lazy(() =>
  import("./terminal-panel").then((module) => ({
    default: module.ProjectTerminalTabsPanel,
  })),
);
const StashPanel = lazy(() =>
  import("./stash-panel").then((module) => ({
    default: module.StashPanel,
  })),
);

const RIGHT_PANEL_SURFACE_CLASSES =
  "overflow-hidden rounded-lg border border-surface-300 dark:border-surface-700 bg-background text-foreground shadow-md";

// Expanded, the surface loses its frame and the headers blend into the
// workspace. The area under each view's header (marked data-right-panel-body)
// becomes the card: its top border takes over the header's bottom line, and
// it gets a right border and a rounded top-right corner. The ring paints the
// header color into the corner outside the curve, hiding the header's line
// there; elsewhere it falls on the header itself or is clipped.
const EXPANDED_BODY_CLASSES = [
  "[&_[data-right-panel-body]]:-mt-px",
  "[&_[data-right-panel-body]]:rounded-tr-lg",
  "[&_[data-right-panel-body]]:border-t",
  "[&_[data-right-panel-body]]:border-r",
  "[&_[data-right-panel-body]]:border-surface-200",
  "dark:[&_[data-right-panel-body]]:border-surface-800",
  "[&_[data-right-panel-body]]:ring-4",
  "[&_[data-right-panel-body]]:ring-surface-50",
  "dark:[&_[data-right-panel-body]]:ring-surface-900",
].join(" ");

const RightPanelLoadingFallback = () => (
  <div className="flex h-full items-center justify-center">
    <Spinner className="text-muted-foreground" />
  </div>
);

export interface RightPanelViewsProps {
  active?: boolean;
  panelExpanded?: boolean;
  onClosePanel: () => void;
  onTogglePanelExpanded?: () => void;
  open: boolean;
  project: ProjectConfig;
  rightPanelView: RightPanelView;
}

const RightPanelViewSlot = ({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) => (
  <div
    aria-hidden={!active}
    className="absolute inset-0 min-h-0 overflow-hidden"
    style={{
      pointerEvents: active ? "auto" : "none",
      visibility: active ? "visible" : "hidden",
    }}
  >
    {children}
  </div>
);

export const RightPanelViews = (props: RightPanelViewsProps) => {
  // The file tree loads once; when the project's host comes back it loads
  // again from scratch (what it tried while the host was away failed).
  const hostAway = useHostAway(props.project) !== null;
  const baseColor = useUiStore((state) => state.baseColor);
  const rightPanelView = props.rightPanelView;
  // Every visited view stays mounted. Terminals in particular must not be
  // torn down on a view switch: each xterm rebuild replays scrollback and
  // allocates a new WebGL context, and leaked contexts eventually force live
  // terminals onto the much slower DOM renderer.
  const [visitedPersistentViews, setVisitedPersistentViews] = useState(
    () => new Set<RightPanelView>(props.open ? [rightPanelView] : []),
  );

  useEffect(() => {
    if (props.open) {
      setVisitedPersistentViews((visitedViews) => {
        if (visitedViews.has(rightPanelView)) {
          return visitedViews;
        }

        return new Set([...visitedViews, rightPanelView]);
      });
    }
  }, [props.open, rightPanelView]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col",
        props.panelExpanded ? "pt-0" : "pt-2",
      )}
    >
      <div
        className={cn(
          RIGHT_PANEL_SURFACE_CLASSES,
          "flex min-h-0 flex-1 flex-col",
          props.panelExpanded &&
            cn("rounded-none border-0 shadow-none", EXPANDED_BODY_CLASSES),
        )}
        data-base-color={baseColor === "neutral" ? undefined : baseColor}
      >
        <div className="relative min-h-0 flex-1">
          <Suspense fallback={<RightPanelLoadingFallback />}>
            {visitedPersistentViews.has("git") ? (
              <RightPanelViewSlot active={rightPanelView === "git"}>
                <GitPanel
                  key={props.project.id}
                  project={props.project}
                  active={
                    Boolean(props.active) &&
                    props.open &&
                    rightPanelView === "git"
                  }
                  expanded={props.panelExpanded}
                  onClosePanel={props.onClosePanel}
                  onToggleExpanded={props.onTogglePanelExpanded}
                />
              </RightPanelViewSlot>
            ) : null}
            {visitedPersistentViews.has("explorer") ? (
              <RightPanelViewSlot active={rightPanelView === "explorer"}>
                <FileExplorerPanel
                  key={hostAway ? "host-away" : "host-here"}
                  active={
                    props.active && props.open && rightPanelView === "explorer"
                  }
                  expanded={props.panelExpanded}
                  onClosePanel={props.onClosePanel}
                  onToggleExpanded={props.onTogglePanelExpanded}
                  projectId={props.project.id}
                />
              </RightPanelViewSlot>
            ) : null}
            {/* The webview browser is the desktop window's (a host-owned
                browser for every client is CONN-11). */}
            {visitedPersistentViews.has("browser") && hasDesktopApi() ? (
              <RightPanelViewSlot active={rightPanelView === "browser"}>
                <BrowserPanel
                  active={
                    props.active && props.open && rightPanelView === "browser"
                  }
                  expanded={props.panelExpanded}
                  onClosePanel={props.onClosePanel}
                  onToggleExpanded={props.onTogglePanelExpanded}
                  project={props.project}
                />
              </RightPanelViewSlot>
            ) : null}
            {visitedPersistentViews.has("stash") ? (
              <RightPanelViewSlot active={rightPanelView === "stash"}>
                <StashPanel
                  active={
                    props.active && props.open && rightPanelView === "stash"
                  }
                  expanded={props.panelExpanded}
                  onClosePanel={props.onClosePanel}
                  onToggleExpanded={props.onTogglePanelExpanded}
                  project={props.project}
                />
              </RightPanelViewSlot>
            ) : null}
            {visitedPersistentViews.has("terminal") ? (
              <RightPanelViewSlot active={rightPanelView === "terminal"}>
                <ProjectTerminalTabsPanel
                  active={
                    props.active && props.open && rightPanelView === "terminal"
                  }
                  embedded={true}
                  expanded={props.panelExpanded}
                  onClosePanel={props.onClosePanel}
                  onToggleExpanded={props.onTogglePanelExpanded}
                  projectId={props.project.id}
                />
              </RightPanelViewSlot>
            ) : null}
          </Suspense>
        </div>
      </div>
    </div>
  );
};
