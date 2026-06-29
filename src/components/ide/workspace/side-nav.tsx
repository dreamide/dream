import { History, MessageSquarePlus, MessagesSquare } from "lucide-react";
import { useTranslations } from "next-intl";
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
  const t = useTranslations("workspace");
  const multiChatLabel = multiChat
    ? t("disableMultiChat")
    : t("enableMultiChat");

  return (
    <aside className="flex w-12 shrink-0 flex-col items-center py-2">
      <div className="flex flex-col items-center gap-1">
        <WorkspaceNavButton
          aria-label={t("chatHistory")}
          active={historyOpen}
          onClick={onToggleHistory}
          ref={historyButtonRef}
          title={t("chatHistory")}
        >
          <History className="size-4" />
        </WorkspaceNavButton>
        <WorkspaceNavButton
          aria-label={t("newChat")}
          onClick={onAddChat}
          title={t("newChat")}
        >
          <MessageSquarePlus className="size-4" />
        </WorkspaceNavButton>
        <WorkspaceNavButton
          aria-label={multiChatLabel}
          aria-pressed={multiChat}
          accent={multiChat}
          data-state={multiChat ? "on" : "off"}
          onClick={onToggleMultiChat}
          title={multiChatLabel}
        >
          <MessagesSquare className="size-4" />
        </WorkspaceNavButton>
      </div>
    </aside>
  );
};

export const WorkspaceSideNav = memo(WorkspaceSideNavImpl);
WorkspaceSideNav.displayName = "WorkspaceSideNav";
