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
import { useChatAcceptsTask } from "./use-chat-accepts-task";

export interface RunTaskSubmenuProps {
  /** The chat whose composer this sits in; a picked task is sent to it. */
  chatId: string;
  /** Fills `{{branch}}`. */
  branch: string | null;
  projectId: string;
}

/**
 * "Run task" in the composer's + menu: sends a saved task to this chat. Tasks
 * themselves are managed in Settings.
 */
export const RunTaskSubmenu = ({
  branch,
  chatId,
  projectId,
}: RunTaskSubmenuProps) => {
  const t = useTranslations("tasks");
  const tasks = useIdeStore((state) => state.tasks);
  const runTask = useIdeStore((state) => state.runTask);
  const setSettingsSection = useIdeStore((state) => state.setSettingsSection);
  const setSettingsOpen = useIdeStore((state) => state.setSettingsOpen);
  const accepts = useChatAcceptsTask(chatId);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="min-w-44 whitespace-nowrap"
        disabled={!accepts}
        title={accepts ? undefined : t("chatBusy")}
      >
        <Play className="mr-2 size-3.5" />
        <span className="truncate">{t("runTask")}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-max min-w-56 max-w-80">
        {tasks.length === 0 ? (
          <DropdownMenuItem className="text-xs" disabled>
            {t("emptyShort")}
          </DropdownMenuItem>
        ) : (
          tasks.map((task) => (
            <DropdownMenuItem
              className="flex-col items-start gap-0.5 text-xs"
              key={task.id}
              onClick={() => runTask(projectId, task.id, { branch, chatId })}
            >
              <span className="max-w-72 truncate font-medium">
                {task.title}
              </span>
              <span className="line-clamp-1 max-w-72 text-muted-foreground">
                {task.prompt}
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-xs"
          onClick={() => {
            setSettingsSection("tasks");
            setSettingsOpen(true);
          }}
        >
          <Settings2 className="mr-2 size-3.5" />
          {t("manageTasks")}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
};
