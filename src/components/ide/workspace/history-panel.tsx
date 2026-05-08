import { memo, type RefObject, useRef } from "react";
import type { ProjectConfig } from "@/types/ide";
import { ProjectSidebar } from "../projects-panel";
import {
  CHAT_HISTORY_PANEL_MAX_WIDTH_PX,
  CHAT_HISTORY_PANEL_MIN_WIDTH_PX,
  SLIDING_PANEL_TRANSITION,
  WORKSPACE_SIDE_NAV_WIDTH_PX,
} from "./constants";
import { WorkspaceSlidingPanel } from "./sliding-panel";

export interface WorkspaceHistoryPanelProps {
  active: boolean;
  historyOpen: boolean;
  historyPanelRef: RefObject<HTMLDivElement | null>;
  historyPanelWidth: number;
  onChatSelect: () => void;
  onResizeEnd: (width: number) => void;
  project: ProjectConfig;
}

const WorkspaceHistoryPanelImpl = ({
  active,
  historyOpen,
  historyPanelRef,
  historyPanelWidth,
  onChatSelect,
  onResizeEnd,
  project,
}: WorkspaceHistoryPanelProps) => {
  const widthRef = useRef(historyPanelWidth);

  return (
    <WorkspaceSlidingPanel
      className="z-30"
      contentClassName="py-2"
      contentMinWidth={CHAT_HISTORY_PANEL_MIN_WIDTH_PX}
      maxWidth={CHAT_HISTORY_PANEL_MAX_WIDTH_PX}
      minWidth={CHAT_HISTORY_PANEL_MIN_WIDTH_PX}
      onHandleDoubleClick={onChatSelect}
      onResizeEnd={onResizeEnd}
      open={historyOpen}
      reserveSpace={false}
      side="left"
      slotRef={historyPanelRef}
      style={{ left: WORKSPACE_SIDE_NAV_WIDTH_PX }}
      transition={SLIDING_PANEL_TRANSITION}
      width={historyPanelWidth}
      widthRef={widthRef}
    >
      {active ? (
        <ProjectSidebar
          className="h-full"
          onChatSelect={onChatSelect}
          project={project}
        />
      ) : null}
    </WorkspaceSlidingPanel>
  );
};

export const WorkspaceHistoryPanel = memo(WorkspaceHistoryPanelImpl);
WorkspaceHistoryPanel.displayName = "WorkspaceHistoryPanel";
