import { History, MessageSquarePlus, Settings } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface WorkspaceSideNavProps {
  historyButtonRef: RefObject<HTMLButtonElement | null>;
  historyOpen: boolean;
  onAddChat: () => void;
  onOpenSettings: () => void;
  onToggleHistory: () => void;
}

export const WorkspaceSideNav = ({
  historyButtonRef,
  historyOpen,
  onAddChat,
  onOpenSettings,
  onToggleHistory,
}: WorkspaceSideNavProps) => (
  <aside className="flex w-12 shrink-0 flex-col items-center py-2">
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
      aria-label="Settings"
      className="mt-auto size-8 text-muted-foreground hover:text-foreground"
      onClick={onOpenSettings}
      size="icon"
      title="Settings"
      variant="ghost"
    >
      <Settings className="size-4" />
    </Button>
  </aside>
);
