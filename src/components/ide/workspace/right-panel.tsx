import { type MutableRefObject, memo, type RefObject } from "react";
import type { ProjectConfig, RightPanelView } from "@/types/ide";
import { RightPanelViews } from "../right-panel-views";
import { BROWSER_PANEL_MIN_WIDTH_PX } from "./constants";
import { WorkspaceSlidingPanel } from "./sliding-panel";

export interface WorkspaceRightPanelProps {
  active: boolean;
  browserHostRef: RefObject<HTMLDivElement | null>;
  browserResizeHidden: boolean;
  handleVisible: boolean;
  maxWidth: number;
  onResizeEnd: (width: number) => void;
  onResizeStart: () => void;
  onSyncBrowserBounds: (reload?: boolean) => void;
  onToggleRightPanel: () => void;
  open: boolean;
  project: ProjectConfig;
  rightPanelRef: RefObject<HTMLDivElement | null>;
  rightPanelTransition: string;
  rightPanelView: RightPanelView;
  width: number;
  widthRef: MutableRefObject<number>;
}

const WorkspaceRightPanelImpl = ({
  active,
  browserHostRef,
  browserResizeHidden,
  handleVisible,
  maxWidth,
  onResizeEnd,
  onResizeStart,
  onSyncBrowserBounds,
  onToggleRightPanel,
  open,
  project,
  rightPanelRef,
  rightPanelTransition,
  rightPanelView,
  width,
  widthRef,
}: WorkspaceRightPanelProps) => (
  <WorkspaceSlidingPanel
    contentClassName="pb-2"
    contentMinWidth={BROWSER_PANEL_MIN_WIDTH_PX}
    handleVisible={handleVisible}
    maxWidth={maxWidth}
    minWidth={BROWSER_PANEL_MIN_WIDTH_PX}
    onHandleDoubleClick={onToggleRightPanel}
    onResizeEnd={onResizeEnd}
    onResizeStart={onResizeStart}
    open={open}
    panelRef={rightPanelRef}
    reserveSpace={true}
    side="right"
    transition={rightPanelTransition}
    width={width}
    widthRef={widthRef}
  >
    <RightPanelViews
      active={active}
      browserHostRef={browserHostRef}
      browserResizeHidden={browserResizeHidden}
      onSyncBrowserBounds={onSyncBrowserBounds}
      project={project}
      rightPanelView={rightPanelView}
    />
  </WorkspaceSlidingPanel>
);

export const WorkspaceRightPanel = memo(WorkspaceRightPanelImpl);
WorkspaceRightPanel.displayName = "WorkspaceRightPanel";
