import { Play, Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useIdeStore } from "../ide-store";
import { useChatAcceptsSavedPrompt } from "./use-chat-accepts-saved-prompt";

export interface RunSavedPromptSubmenuProps {
  /** The chat whose composer this sits in; a picked saved prompt is sent to it. */
  chatId: string;
  projectId: string;
}

/**
 * "Run prompt" in the composer's + menu: sends a saved prompt to this chat. The
 * prompts themselves are managed in Settings.
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

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="min-w-44 whitespace-nowrap"
        disabled={!accepts}
        title={accepts ? undefined : t("chatBusy")}
      >
        <Play className="mr-2 size-3.5" />
        <span className="truncate">{t("runPrompt")}</span>
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
              onClick={() => runSavedPrompt(projectId, savedPrompt.id, chatId)}
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
