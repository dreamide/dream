import { History, MessageSquarePlus, MessagesSquare } from "lucide-react";
import { memo, type RefObject } from "react";
import { WorkspaceNavButton } from "./nav-button";

export interface WorkspaceSideNavProps {
  historyButtonRef: RefObject<HTMLButtonElement | null>;
  historyOpen: boolean;
  multiChat: boolean;
  onAddChat: () => void;
  onToggleMultiChat: () => void;
  onToggleHistory: () => void;
}

const WorkspaceSideNavImpl = ({
  historyButtonRef,
  historyOpen,
  multiChat,
  onAddChat,
  onToggleMultiChat,
  onToggleHistory,
}: WorkspaceSideNavProps) => {
  return (
    <aside className="flex w-12 shrink-0 flex-col items-center py-2">
      <div className="flex flex-col items-center gap-1">
        <WorkspaceNavButton
          aria-label="Chat history"
          active={historyOpen}
          onClick={onToggleHistory}
          ref={historyButtonRef}
          title="Chat history"
        >
          <History className="size-4" />
        </WorkspaceNavButton>
        <WorkspaceNavButton
          aria-label="New chat"
          onClick={onAddChat}
          title="New chat"
        >
          <MessageSquarePlus className="size-4" />
        </WorkspaceNavButton>
        <WorkspaceNavButton
          aria-label={multiChat ? "Disable multi-chat" : "Enable multi-chat"}
          aria-pressed={multiChat}
          accent={multiChat}
          data-state={multiChat ? "on" : "off"}
          onClick={onToggleMultiChat}
          title={multiChat ? "Disable multi-chat" : "Enable multi-chat"}
        >
          <MessagesSquare className="size-4" />
        </WorkspaceNavButton>
      </div>
    </aside>
  );
};

export const WorkspaceSideNav = memo(WorkspaceSideNavImpl);
WorkspaceSideNav.displayName = "WorkspaceSideNav";
