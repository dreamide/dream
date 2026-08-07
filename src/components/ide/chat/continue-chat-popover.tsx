import { FolderIcon, FolderTreeIcon, Forward } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import type { ChatConfig } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { slugifyWorktreeBranchName } from "../worktree-fields";

export type ContinueChatPopoverContext = {
  chat: ChatConfig;
  currentBranch: string | null;
  isProcessing: boolean;
  isRepo: boolean;
  onError: (message: string) => void;
};

const createAutomaticBranchName = (title: string) => {
  const suffix = Date.now().toString(36);
  const base = slugifyWorktreeBranchName(title);
  return `${base.slice(0, Math.max(1, 47 - suffix.length))}-${suffix}`;
};

export const ContinueChatPopover = ({
  chat,
  currentBranch,
  isProcessing,
  isRepo,
  messageId,
  onError,
}: ContinueChatPopoverContext & { messageId: string }) => {
  const chatT = useTranslations("chat");
  const branchChatInWorkspace = useIdeStore(
    (state) => state.branchChatInWorkspace,
  );
  const branchChatInNewWorktree = useIdeStore(
    (state) => state.branchChatInNewWorktree,
  );
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isProcessing) {
      setOpen(false);
    }
  }, [isProcessing]);

  const continueInWorkspace = () => {
    if (isProcessing || submitting) {
      return;
    }

    try {
      branchChatInWorkspace({ chatId: chat.id, messageId });
      setOpen(false);
    } catch {
      onError(chatT("unableToCreateBranch"));
    }
  };

  const continueInWorktree = async () => {
    if (isProcessing || submitting || !isRepo) {
      return;
    }

    setSubmitting(true);
    try {
      await branchChatInNewWorktree({
        baseRef: currentBranch,
        branchName: createAutomaticBranchName(chat.title),
        chatId: chat.id,
        messageId,
      });
      setOpen(false);
    } catch {
      onError(chatT("unableToCreateBranch"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        render={
          <button
            aria-label={chatT("continueFromMessage")}
            className="pointer-events-auto rounded p-1 transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isProcessing}
            type="button"
          />
        }
      >
        <Forward className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        className="w-max text-xs"
        side="top"
        sideOffset={6}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="whitespace-nowrap font-normal">
            {chatT("continueInNewChat")}
          </DropdownMenuLabel>
          <DropdownMenuItem
            className="gap-1.5 whitespace-nowrap text-xs"
            disabled={isProcessing || submitting}
            onClick={continueInWorkspace}
          >
            <FolderIcon className="size-3.5 shrink-0 text-surface-500 dark:text-surface-400" />
            {chatT("useThisWorkspace")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-1.5 whitespace-nowrap text-xs"
            closeOnClick={false}
            disabled={isProcessing || submitting || !isRepo}
            onClick={() => void continueInWorktree()}
            title={!isRepo ? chatT("worktreeRequiresGit") : undefined}
          >
            {submitting ? (
              <Spinner className="size-3.5 shrink-0 text-surface-500 dark:text-surface-400" />
            ) : (
              <FolderTreeIcon className="size-3.5 shrink-0 text-surface-500 dark:text-surface-400" />
            )}
            {chatT("useNewWorktree")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
