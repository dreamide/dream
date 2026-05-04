import type { MutableRefObject, RefObject } from "react";
import { cn } from "@/lib/utils";
import type { ProjectConfig, RightPanelView } from "@/types/ide";
import { BrowserPanel } from "../browser-panel";
import { HorizontalResizablePanel } from "../ide-helpers";
import { BROWSER_PANEL_MIN_WIDTH_PX } from "./constants";

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

export const WorkspaceRightPanel = ({
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
  <HorizontalResizablePanel
    className={cn(handleVisible ? "" : "min-w-0")}
    contentClassName="pb-2"
    contentMinWidth={BROWSER_PANEL_MIN_WIDTH_PX}
    handleSide="left"
    handleVisible={handleVisible}
    maxWidth={maxWidth}
    minWidth={BROWSER_PANEL_MIN_WIDTH_PX}
    onHandleDoubleClick={onToggleRightPanel}
    onResizeEnd={onResizeEnd}
    onResizeStart={onResizeStart}
    open={open}
    panelRef={rightPanelRef}
    style={{
      flex: handleVisible ? undefined : open ? "1 1 0%" : "0 0 0px",
      paddingRight: 0,
      paddingLeft: open && !handleVisible ? 8 : 0,
      willChange: handleVisible
        ? "width, opacity, padding"
        : "flex-basis, opacity, padding",
    }}
    transition={rightPanelTransition}
    width={width}
    widthRef={widthRef}
  >
    <BrowserPanel
      active={active}
      browserHostRef={browserHostRef}
      browserResizeHidden={browserResizeHidden}
      onSyncBrowserBounds={onSyncBrowserBounds}
      project={project}
      rightPanelView={rightPanelView}
    />
  </HorizontalResizablePanel>
);
