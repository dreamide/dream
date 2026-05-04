import type { RefObject } from "react";
import type { ProjectConfig } from "@/types/ide";
import { PanelResizeHandle } from "../ide-helpers";
import { ProjectSidebar } from "../projects-panel";
import {
  CHAT_HISTORY_PANEL_MAX_WIDTH_PX,
  CHAT_HISTORY_PANEL_MIN_WIDTH_PX,
  PANEL_TRANSITION,
  WORKSPACE_SIDE_NAV_WIDTH_PX,
} from "./constants";

export interface WorkspaceHistoryPanelProps {
  active: boolean;
  historyOpen: boolean;
  historyPanelRef: RefObject<HTMLDivElement | null>;
  historyPanelWidth: number;
  onChatSelect: () => void;
  onResize: (deltaX: number) => void;
  onResizeEnd: () => void;
  onResizeStart: () => void;
  project: ProjectConfig;
}

export const WorkspaceHistoryPanel = ({
  active,
  historyOpen,
  historyPanelRef,
  historyPanelWidth,
  onChatSelect,
  onResize,
  onResizeEnd,
  onResizeStart,
  project,
}: WorkspaceHistoryPanelProps) => (
  <div
    aria-hidden={!historyOpen}
    className="absolute top-0 bottom-0 z-30 overflow-hidden"
    inert={!historyOpen}
    ref={historyPanelRef}
    style={{
      boxSizing: "border-box",
      left: WORKSPACE_SIDE_NAV_WIDTH_PX,
      maxWidth: historyOpen ? CHAT_HISTORY_PANEL_MAX_WIDTH_PX : 0,
      minWidth: historyOpen ? CHAT_HISTORY_PANEL_MIN_WIDTH_PX : 0,
      opacity: historyOpen ? 1 : 0,
      pointerEvents: historyOpen ? "auto" : "none",
      transition: PANEL_TRANSITION,
      width: historyOpen ? historyPanelWidth : 0,
      willChange: "width, opacity",
    }}
  >
    <div
      className="flex h-full"
      style={{ minWidth: CHAT_HISTORY_PANEL_MIN_WIDTH_PX }}
    >
      <div className="min-w-0 flex-1 py-2">
        {active && historyOpen ? (
          <ProjectSidebar
            className="h-full"
            onChatSelect={onChatSelect}
            project={project}
          />
        ) : null}
      </div>
      {historyOpen ? (
        <PanelResizeHandle
          onDoubleClick={onChatSelect}
          onResize={onResize}
          onResizeEnd={onResizeEnd}
          onResizeStart={onResizeStart}
          side="right"
        />
      ) : null}
    </div>
  </div>
);
