import { MessageSquarePlus, Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatComposerInsert } from "../chat/chat-composer-insert-context";
import { useIdeStore } from "../ide-store";
import { useChatAcceptsSavedPrompt } from "./use-chat-accepts-saved-prompt";

const RUN_MODIFIER_KEY =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
    ? "Cmd"
    : "Ctrl";

export interface RunSavedPromptSubmenuProps {
  /** The chat whose composer this sits in; Ctrl+click sends a saved prompt to it. */
  chatId: string;
  projectId: string;
}

/**
 * "Add prompt" in the composer's + menu: inserts a saved prompt into the composer
 * so it can be edited before sending. Ctrl+click (Cmd+click on macOS) sends it to
 * this chat right away instead, when the chat can take it. The prompts themselves
 * are managed in Settings.
 */
export const RunSavedPromptSubmenu = ({
  chatId,
  projectId,
}: RunSavedPromptSubmenuProps) => {
  const t = useTranslations("savedPrompts");
  const savedPrompts = useIdeStore((state) => state.savedPrompts);
  const runSavedPrompt = useIdeStore((state) => state.runSavedPrompt);
  const setSettingsSection = useIdeStore((state) => state.setSettingsSection);
  const setSettingsOpen = useIdeStore((state) => state.setSettingsOpen);
  const accepts = useChatAcceptsSavedPrompt(chatId);
  const insertPromptText = useChatComposerInsert();

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="min-w-44 whitespace-nowrap">
        <MessageSquarePlus className="mr-2 size-3.5" />
        <span className="truncate">{t("addPrompt")}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-max min-w-56 max-w-80">
        {savedPrompts.length === 0 ? (
          <DropdownMenuItem className="text-xs" disabled>
            {t("emptyShort")}
          </DropdownMenuItem>
        ) : (
          savedPrompts.map((savedPrompt) => (
            <DropdownMenuItem
              className="flex-col items-start gap-0.5 text-xs"
              key={savedPrompt.id}
              onClick={(event) => {
                // A busy chat cannot take a run, so Ctrl+click falls back to
                // inserting rather than dropping the prompt.
                if ((event.ctrlKey || event.metaKey) && accepts) {
                  runSavedPrompt(projectId, savedPrompt.id, chatId);
                } else {
                  insertPromptText?.(savedPrompt.prompt);
                }
              }}
              title={t("runPromptHint", { key: RUN_MODIFIER_KEY })}
            >
              <span className="max-w-72 truncate font-medium">
                {savedPrompt.name}
              </span>
              <span className="line-clamp-1 max-w-72 text-muted-foreground">
                {savedPrompt.prompt}
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-xs"
          onClick={() => {
            setSettingsSection("prompts");
            setSettingsOpen(true);
          }}
        >
          <Settings2 className="mr-2 size-3.5" />
          {t("managePrompts")}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};
