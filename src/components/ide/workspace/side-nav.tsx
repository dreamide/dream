import { History, MessageSquarePlus, MessagesSquare } from "lucide-react";
import { memo, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
}: WorkspaceSideNavProps) => (
  <aside className="flex w-12 shrink-0 flex-col items-center justify-between py-2">
    <div className="flex flex-col items-center gap-1">
      <Button
        aria-label="Chat history"
        className={cn(
          "size-8",
          historyOpen
            ? "text-foreground hover:text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
        onClick={onToggleHistory}
        ref={historyButtonRef}
        size="icon"
        title="Chat history"
        variant="ghost"
      >
        <History className="size-4" />
      </Button>
      <Button
        aria-label="New chat"
        className="size-8 text-muted-foreground hover:text-foreground"
        onClick={onAddChat}
        size="icon"
        title="New chat"
        variant="ghost"
      >
        <MessageSquarePlus className="size-4" />
      </Button>
    </div>
    <Button
      aria-label={multiChat ? "Disable multi-chat" : "Enable multi-chat"}
      aria-pressed={multiChat}
      className={cn(
        "size-8",
        multiChat
          ? "text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
          : "text-muted-foreground hover:text-foreground",
      )}
      data-state={multiChat ? "on" : "off"}
      onClick={onToggleMultiChat}
      size="icon"
      title={multiChat ? "Disable multi-chat" : "Enable multi-chat"}
      variant="ghost"
    >
      <MessagesSquare className="size-4" />
    </Button>
  </aside>
);

export const WorkspaceSideNav = memo(WorkspaceSideNavImpl);
WorkspaceSideNav.displayName = "WorkspaceSideNav";
