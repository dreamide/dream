import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type { ProjectConfig } from "@/types/ide";
import type { RightPanelView } from "./ide-types";

const BrowserPanel = lazy(() =>
  import("./browser-panel").then((module) => ({
    default: module.BrowserPanel,
  })),
);
const ChangesPanel = lazy(() =>
  import("./changes-panel").then((module) => ({
    default: module.ChangesPanel,
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

const RightPanelLoadingFallback = () => (
  <div className="flex h-full items-center justify-center">
    <Spinner className="text-muted-foreground" />
  </div>
);

export interface RightPanelViewsProps {
  active?: boolean;
  browserExpanded?: boolean;
  onClosePanel: () => void;
  onToggleBrowserExpanded?: () => void;
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
  const baseColor = useUiStore((state) => state.baseColor);
  const rightPanelView = props.rightPanelView;
  const [visitedPersistentViews, setVisitedPersistentViews] = useState(
    () =>
      new Set<RightPanelView>(
        props.open && rightPanelView !== "terminal" ? [rightPanelView] : [],
      ),
  );

  useEffect(() => {
    if (props.open && rightPanelView !== "terminal") {
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
        props.browserExpanded ? "pt-0" : "pt-2",
      )}
    >
      <div
        className={cn(
          RIGHT_PANEL_SURFACE_CLASSES,
          "flex min-h-0 flex-1 flex-col",
          props.browserExpanded && "rounded-none border-0 shadow-none",
        )}
        data-base-color={baseColor === "neutral" ? undefined : baseColor}
      >
        <div className="relative min-h-0 flex-1">
          <Suspense fallback={<RightPanelLoadingFallback />}>
            {visitedPersistentViews.has("explorer") ? (
              <RightPanelViewSlot active={rightPanelView === "explorer"}>
                <FileExplorerPanel
                  active={
                    props.active && props.open && rightPanelView === "explorer"
                  }
                  onClosePanel={props.onClosePanel}
                  projectId={props.project.id}
                />
              </RightPanelViewSlot>
            ) : null}
            {visitedPersistentViews.has("changes") ? (
              <RightPanelViewSlot active={rightPanelView === "changes"}>
                <ChangesPanel
                  active={
                    props.active && props.open && rightPanelView === "changes"
                  }
                  onClosePanel={props.onClosePanel}
                  projectId={props.project.id}
                />
              </RightPanelViewSlot>
            ) : null}
            {visitedPersistentViews.has("browser") ? (
              <RightPanelViewSlot active={rightPanelView === "browser"}>
                <BrowserPanel
                  active={
                    props.active && props.open && rightPanelView === "browser"
                  }
                  expanded={props.browserExpanded}
                  onClosePanel={props.onClosePanel}
                  onToggleExpanded={props.onToggleBrowserExpanded}
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
                  onClosePanel={props.onClosePanel}
                  project={props.project}
                />
              </RightPanelViewSlot>
            ) : null}
            {rightPanelView === "terminal" ? (
              <RightPanelViewSlot active={true}>
                <ProjectTerminalTabsPanel
                  active={props.active && props.open}
                  embedded={true}
                  onClosePanel={props.onClosePanel}
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
