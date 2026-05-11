import { Ellipsis, FilePenLine, Trash2, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";

export interface ChatPanelHeaderProps {
  canShowChatMenu: boolean;
  canCloseChat?: boolean;
  chatMenuOpen: boolean;
  isTitleGenerating?: boolean;
  onCloseChat?: () => void;
  onChatMenuOpenChange: (open: boolean) => void;
  onDeleteChat: () => void;
  onEditChat: () => void;
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  title: string;
}

export const ChatPanelHeader = ({
  canShowChatMenu,
  canCloseChat = false,
  chatMenuOpen,
  isTitleGenerating = false,
  onCloseChat,
  onChatMenuOpenChange,
  onDeleteChat,
  onEditChat,
  onHeaderPointerDown,
  title,
}: ChatPanelHeaderProps) => {
  const titleText =
    isTitleGenerating && title.trim().toLowerCase() === "new chat" ? "" : title;

  return (
    <div className="shrink-0 px-2 pt-2">
      <div
        className={`mx-auto flex w-full max-w-[700px] items-center justify-between gap-3 pb-2${onHeaderPointerDown ? " cursor-grab active:cursor-grabbing" : ""}`}
        onPointerDown={onHeaderPointerDown}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            {isTitleGenerating ? <Spinner className="size-3 shrink-0" /> : null}
            {titleText ? (
              <p className="truncate font-medium text-sm">{titleText}</p>
            ) : null}
          </div>
        </div>

        {canShowChatMenu || canCloseChat ? (
          <div
            className="flex shrink-0 cursor-default items-center gap-1"
            onPointerDown={(event) => event.stopPropagation()}
          >
            {canShowChatMenu ? (
              <DropdownMenu
                onOpenChange={onChatMenuOpenChange}
                open={chatMenuOpen}
              >
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label={`${title} actions`}
                      className="h-8 w-8 p-0"
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    />
                  }
                >
                  <Ellipsis className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onClick={onEditChat}>
                    <FilePenLine className="size-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onDeleteChat}>
                    <Trash2 className="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {canCloseChat ? (
              <Button
                aria-label={`Close ${title}`}
                className="h-8 w-8 p-0"
                onClick={onCloseChat}
                size="icon-sm"
                title="Close chat"
                type="button"
                variant="ghost"
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};
