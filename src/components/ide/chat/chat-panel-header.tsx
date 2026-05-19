import { Ellipsis, FilePenLine, Trash2, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
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
  onRenameChat?: (title: string) => void;
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
  onRenameChat,
  title,
}: ChatPanelHeaderProps) => {
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const titleText =
    isTitleGenerating && title.trim().toLowerCase() === "new chat" ? "" : title;

  useEffect(() => {
    if (!editingTitle) {
      setDraftTitle(title);
    }
  }, [editingTitle, title]);

  useEffect(() => {
    if (!editingTitle) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [editingTitle]);

  const commitRename = useCallback(() => {
    const nextTitle = draftTitle.trim();
    if (nextTitle) {
      onRenameChat?.(nextTitle);
    }
    setEditingTitle(false);
  }, [draftTitle, onRenameChat]);

  return (
    <div className="shrink-0 px-2 pt-2">
      <div
        className={`mx-auto flex w-full max-w-[700px] items-center justify-between gap-3 pb-2${onHeaderPointerDown ? " cursor-grab active:cursor-grabbing" : ""}`}
        onPointerDown={onHeaderPointerDown}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 min-w-0 items-center gap-2">
            {isTitleGenerating ? <Spinner className="size-3 shrink-0" /> : null}
            {editingTitle ? (
              <Input
                ref={inputRef}
                className="h-6 min-w-0 flex-1 rounded-none border-0 border-b border-surface-300 bg-transparent px-0 py-0 font-medium text-sm leading-5 shadow-none focus-visible:ring-0 dark:border-surface-700"
                onBlur={commitRename}
                onChange={(event) => setDraftTitle(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  }

                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDraftTitle(title);
                    setEditingTitle(false);
                  }
                }}
                onPointerDown={(event) => event.stopPropagation()}
                value={draftTitle}
              />
            ) : titleText ? (
              <button
                className="block h-6 min-w-0 flex-1 truncate border-b border-transparent p-0 text-left font-medium text-sm leading-5"
                onDoubleClick={(event) => {
                  if (!onRenameChat) {
                    return;
                  }

                  event.preventDefault();
                  event.stopPropagation();
                  setDraftTitle(title);
                  setEditingTitle(true);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title="Double-click to rename"
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
