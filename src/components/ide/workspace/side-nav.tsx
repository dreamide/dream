import { History, MessageSquarePlus, MessagesSquare } from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, type PropsWithChildren, type RefObject } from "react";
import { useShortcutTitle } from "../shortcuts/shortcut-keys";
import { WorkspaceNavButton } from "./nav-button";

export const WorkspaceNavRail = ({ children }: PropsWithChildren) => (
  <aside className="flex w-12 shrink-0 flex-col items-center py-2">
    <div className="flex flex-col items-center gap-1">{children}</div>
  </aside>
);

export interface WorkspaceSideNavProps {
  historyButtonRef: RefObject<HTMLButtonElement | null>;
  historyHasUnseenChats: boolean;
  historyOpen: boolean;
  multiChat: boolean;
  onAddChat: () => void;
  onToggleMultiChat: () => void;
  onToggleHistory: () => void;
}

const WorkspaceSideNavImpl = ({
  historyButtonRef,
  historyHasUnseenChats,
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
  const historyTitle = useShortcutTitle("toggleChatHistory", t("chatHistory"));
  const newChatTitle = useShortcutTitle("newChat", t("newChat"));
  const multiChatTitle = useShortcutTitle("toggleSideBySide", multiChatLabel);

  return (
    <WorkspaceNavRail>
      <WorkspaceNavButton
        aria-label={t("chatHistory")}
        active={historyOpen}
        accent={historyHasUnseenChats}
        onClick={onToggleHistory}
        ref={historyButtonRef}
        title={historyTitle}
      >
        <History className="size-4" />
      </WorkspaceNavButton>
      <WorkspaceNavButton
        aria-label={t("newChat")}
        onClick={onAddChat}
        title={newChatTitle}
      >
        <MessageSquarePlus className="size-4" />
      </WorkspaceNavButton>
      <WorkspaceNavButton
        aria-label={multiChatLabel}
        aria-pressed={multiChat}
        accent={multiChat}
        data-state={multiChat ? "on" : "off"}
        onClick={onToggleMultiChat}
        title={multiChatTitle}
      >
        <MessagesSquare className="size-4" />
      </WorkspaceNavButton>
    </WorkspaceNavRail>
  );
};

export const WorkspaceSideNav = memo(WorkspaceSideNavImpl);
WorkspaceSideNav.displayName = "WorkspaceSideNav";
