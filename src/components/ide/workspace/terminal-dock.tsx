import type { RefObject } from "react";
import { PanelResizeHandle } from "../ide-helpers";
import { ProjectTerminalTabsPanel } from "../terminal-panel";
import {
  CHAT_PANEL_MIN_HEIGHT_PX,
  PANEL_RESIZE_HANDLE_SIZE_PX,
  TERMINAL_PANEL_MIN_HEIGHT_PX,
} from "./constants";

export interface WorkspaceTerminalDockProps {
  active: boolean;
  hasProjectTerminalSessions: boolean;
  onOpenTerminal: () => void;
  onResize: (deltaY: number) => void;
  onResizeEnd: () => void;
  onResizeStart: () => void;
  projectId: string;
  terminalHeight: number;
  terminalPanelRef: RefObject<HTMLDivElement | null>;
  terminalPanelTransition: string;
  terminalPanelVisible: boolean;
  terminalPanelWrapperRef: RefObject<HTMLDivElement | null>;
}

export const WorkspaceTerminalDock = ({
  active,
  hasProjectTerminalSessions,
  onOpenTerminal,
  onResize,
  onResizeEnd,
  onResizeStart,
  projectId,
  terminalHeight,
  terminalPanelRef,
  terminalPanelTransition,
  terminalPanelVisible,
  terminalPanelWrapperRef,
}: WorkspaceTerminalDockProps) => (
  <div
    ref={terminalPanelWrapperRef}
    className="shrink-0 overflow-hidden"
    style={{
      height: terminalPanelVisible
        ? terminalHeight + PANEL_RESIZE_HANDLE_SIZE_PX
        : 0,
      maxHeight: `calc(100% - ${CHAT_PANEL_MIN_HEIGHT_PX}px)`,
      opacity: terminalPanelVisible ? 1 : 0,
      pointerEvents: terminalPanelVisible ? "auto" : "none",
      transition: terminalPanelTransition,
      willChange: "height, opacity",
    }}
  >
    <PanelResizeHandle
      onDoubleClick={onOpenTerminal}
      onResize={onResize}
      onResizeEnd={onResizeEnd}
      onResizeStart={onResizeStart}
      side="top"
    />
    <div
      ref={terminalPanelRef}
      className="relative shrink-0 overflow-hidden"
      style={{
        height: terminalPanelVisible ? terminalHeight : 0,
        minHeight: terminalPanelVisible ? TERMINAL_PANEL_MIN_HEIGHT_PX : 0,
        maxHeight: `calc(100% - ${PANEL_RESIZE_HANDLE_SIZE_PX}px)`,
        transition: terminalPanelTransition,
        willChange: "height, opacity",
      }}
    >
      {hasProjectTerminalSessions ? (
        <div className="absolute inset-0 min-h-0">
          <ProjectTerminalTabsPanel
            active={active && terminalPanelVisible}
            projectId={projectId}
          />
        </div>
      ) : null}
    </div>
  </div>
);
