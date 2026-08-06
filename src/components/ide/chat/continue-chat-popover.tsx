import { FolderIcon, FolderTreeIcon, Split } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
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
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <button
            aria-label={chatT("continueFromMessage")}
            className="pointer-events-auto rounded p-1 transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isProcessing}
            type="button"
          />
        }
      >
        <Split className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-56 gap-1 p-1.5"
        side="top"
        sideOffset={6}
      >
        <PopoverTitle className="px-2 py-1.5 text-xs">
          {chatT("continueInNewChat")}
        </PopoverTitle>
        <Button
          className="w-full justify-start"
          disabled={isProcessing || submitting}
          onClick={continueInWorkspace}
          size="sm"
          type="button"
          variant="ghost"
        >
          <FolderIcon className="size-4" />
          {chatT("useThisWorkspace")}
        </Button>
        <Button
          className="w-full justify-start"
          disabled={isProcessing || submitting || !isRepo}
          onClick={() => void continueInWorktree()}
          size="sm"
          title={!isRepo ? chatT("worktreeRequiresGit") : undefined}
          type="button"
          variant="ghost"
        >
          {submitting ? (
            <Spinner className="size-4" />
          ) : (
            <FolderTreeIcon className="size-4" />
          )}
          {chatT("useNewWorktree")}
        </Button>
      </PopoverContent>
    </Popover>
  );
};
