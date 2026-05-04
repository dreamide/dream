import { Ellipsis, FilePenLine, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ChatPanelHeaderProps {
  canShowChatMenu: boolean;
  chatMenuOpen: boolean;
  onChatMenuOpenChange: (open: boolean) => void;
  onDeleteChat: () => void;
  onRenameChat: () => void;
  title: string;
}

export const ChatPanelHeader = ({
  canShowChatMenu,
  chatMenuOpen,
  onChatMenuOpenChange,
  onDeleteChat,
  onRenameChat,
  title,
}: ChatPanelHeaderProps) => (
  <div className="shrink-0 px-2 pt-2">
    <div className="mx-auto flex w-full max-w-[700px] items-center justify-between gap-3 pb-2">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-sm">{title}</p>
      </div>

      {canShowChatMenu ? (
        <div className="flex shrink-0 items-center gap-1">
          <DropdownMenu onOpenChange={onChatMenuOpenChange} open={chatMenuOpen}>
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
              <DropdownMenuItem onClick={onRenameChat}>
                <FilePenLine className="size-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDeleteChat}>
                <Trash2 className="size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}
    </div>
  </div>
);
