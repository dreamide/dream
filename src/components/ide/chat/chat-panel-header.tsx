import {
  Archive,
  Ellipsis,
  FilePenLine,
  SquareTerminal,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ChatPanelHeaderProps {
  canShowChatMenu: boolean;
  canCloseChat?: boolean;
  chatMenuOpen: boolean;
  continueInTerminalDisabled?: boolean;
  isTitleGenerating?: boolean;
  onCloseChat?: () => void;
  onChatMenuOpenChange: (open: boolean) => void;
  /** Absent when the chat cannot be deleted on its own (task chats). */
  onDeleteChat?: () => void;
  onEditChat: () => void;
  onContinueInTerminal?: () => void;
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  title: string;
}

export const ChatPanelHeader = ({
  canShowChatMenu,
  canCloseChat = false,
  chatMenuOpen,
  continueInTerminalDisabled = false,
  isTitleGenerating = false,
  onCloseChat,
  onChatMenuOpenChange,
  onDeleteChat,
  onEditChat,
  onContinueInTerminal,
  onHeaderPointerDown,
  title,
}: ChatPanelHeaderProps) => {
  const chatT = useTranslations("chat");
  const commonT = useTranslations("common");
  const isShowingGeneratedTitlePlaceholder =
    isTitleGenerating && title.trim().toLowerCase() === "new chat";
  const titleText = isShowingGeneratedTitlePlaceholder ? "" : title;

  return (
    <div className="shrink-0 px-2 pt-2">
      <div
        className={`mx-auto flex w-full max-w-[700px] items-center justify-between gap-3 pb-2${onHeaderPointerDown ? " cursor-grab active:cursor-grabbing" : ""}`}
        onPointerDown={onHeaderPointerDown}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 min-w-0 items-center gap-2">
            {isShowingGeneratedTitlePlaceholder ? (
              <span
                aria-live="polite"
                className="block h-6 min-w-0 flex-1 truncate font-medium text-sm leading-5"
              >
                <Shimmer as="span" duration={1.5}>
                  {chatT("generatingTitle")}
                </Shimmer>
              </span>
            ) : titleText ? (
              <button
                className="block h-6 min-w-0 flex-1 truncate border-b border-transparent p-0 text-left font-medium text-sm leading-5"
                data-chat-header-drag-handle="true"
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onEditChat();
                }}
                title={chatT("doubleClickToRename")}
                type="button"
              >
                {titleText}
              </button>
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
                      aria-label={chatT("chatActions", { title })}
                      className="h-8 w-8 p-0"
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    />
                  }
                >
                  <Ellipsis className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  {onContinueInTerminal ? (
                    <DropdownMenuItem
                      disabled={continueInTerminalDisabled}
                      onClick={onContinueInTerminal}
                    >
                      <SquareTerminal className="size-4" />
                      {chatT("continueInTerminal")}
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onClick={onEditChat}>
                    <FilePenLine className="size-4" />
                    {commonT("edit")}
                  </DropdownMenuItem>
                  {onDeleteChat ? (
                    <DropdownMenuItem onClick={onDeleteChat}>
                      <Archive className="size-4" />
                      {commonT("archive")}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {canCloseChat ? (
              <Button
                aria-label={chatT("closeNamedChat", { title })}
                className="h-8 w-8 p-0"
                onClick={onCloseChat}
                size="icon-sm"
                title={chatT("closeChat")}
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
