import { type MutableRefObject, memo, type RefObject } from "react";
import { cn } from "@/lib/utils";
import type { ProjectConfig, RightPanelView } from "@/types/ide";
import { RightPanelViews } from "../right-panel-views";
import { BROWSER_PANEL_MIN_WIDTH_PX } from "./constants";
import { WorkspaceSlidingPanel } from "./sliding-panel";

export interface WorkspaceRightPanelProps {
  active: boolean;
  panelExpanded: boolean;
  handleVisible: boolean;
  maxWidth: number;
  onPanelExpandedChange: (expanded: boolean) => void;
  onCloseRightPanel: () => void;
  onResizeEnd: (width: number) => void;
  onResizeStart: () => void;
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
  panelExpanded,
  handleVisible,
  maxWidth,
  onPanelExpandedChange,
  onCloseRightPanel,
  onResizeEnd,
  onResizeStart,
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
    className={cn(panelExpanded && "left-0 right-0 z-50")}
    contentClassName={panelExpanded ? "pb-0" : "pb-2"}
    contentMinWidth={BROWSER_PANEL_MIN_WIDTH_PX}
    handleVisible={panelExpanded ? false : handleVisible}
    maxWidth={maxWidth}
    minWidth={BROWSER_PANEL_MIN_WIDTH_PX}
    onHandleDoubleClick={onToggleRightPanel}
    onResizeEnd={onResizeEnd}
    onResizeStart={onResizeStart}
    open={open}
    panelRef={rightPanelRef}
    reserveSpace={!panelExpanded}
    side="right"
    transition={rightPanelTransition}
    width={width}
    widthRef={widthRef}
  >
    <RightPanelViews
      active={active}
      panelExpanded={panelExpanded}
      onClosePanel={onCloseRightPanel}
      onTogglePanelExpanded={() => onPanelExpandedChange(!panelExpanded)}
      open={open}
      project={project}
      rightPanelView={rightPanelView}
    />
  </WorkspaceSlidingPanel>
);

export const WorkspaceRightPanel = memo(WorkspaceRightPanelImpl);
WorkspaceRightPanel.displayName = "WorkspaceRightPanel";
