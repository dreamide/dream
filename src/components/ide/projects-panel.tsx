import { Search, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { useIdeStore } from "./ide-store";

const formatLastActiveTime = (value: string) => {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "";
  }

  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) {
    return "now";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 30) {
    return `${deltaDays}d`;
  }

  const deltaMonths = Math.floor(deltaDays / 30);
  if (deltaMonths < 12) {
    return `${deltaMonths}mo`;
  }

  return `${Math.floor(deltaMonths / 12)}y`;
};

export const ProjectSidebar = ({
  className,
  onChatSelect,
  project,
}: {
  className?: string;
  onChatSelect?: () => void;
  project: ProjectConfig;
}) => {
  const allChats = useIdeStore((s) => s.chats);
  const projectUi = useIdeStore(
    (s) => s.projects.find((item) => item.id === project.id)?.ui ?? project.ui,
  );
  const messagesByChatId = useIdeStore((s) => s.messagesByChatId);
  const setActiveChatId = useIdeStore((s) => s.setActiveChatId);
  const streamingChatIds = useIdeStore((s) => s.streamingChatIds);
  const titleGeneratingChatIds = useIdeStore((s) => s.titleGeneratingChatIds);
  const deleteChat = useIdeStore((s) => s.deleteChat);

  const [searchQuery, setSearchQuery] = useState("");

  const activeProjectChats = useMemo<ChatConfig[]>(() => {
    return allChats
      .filter(
        (chat) =>
          chat.projectId === project.id &&
          chat.deletedAt === null &&
          (messagesByChatId[chat.id]?.length ?? 0) > 0,
      )
      .sort((left, right) => {
        const leftUpdated = Date.parse(left.updatedAt);
        const rightUpdated = Date.parse(right.updatedAt);
        if (Number.isNaN(leftUpdated) || Number.isNaN(rightUpdated)) {
          return right.title.localeCompare(left.title);
        }

        return rightUpdated - leftUpdated;
      });
  }, [allChats, messagesByChatId, project.id]);

  const filteredChats = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return activeProjectChats;
    }

    return activeProjectChats.filter((chat) =>
      chat.title.toLowerCase().includes(query),
    );
  }, [activeProjectChats, searchQuery]);

  const activeChatId = projectUi.activeChatId;

  const handleChatSelect = useCallback(
    (chatId: string) => {
      setActiveChatId(project.id, chatId);
    },
    [project.id, setActiveChatId],
  );

  return (
    <div
      id="projects-panel"
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md",
        className,
      )}
    >
      <div className="px-3 py-3">
        <p className="font-medium text-sm">Chat history</p>
        <InputGroup className="mt-2">
          <InputGroupInput
            className="text-sm"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search history..."
            value={searchQuery}
          />
          <InputGroupAddon>
            <Search className="size-4 shrink-0 opacity-50" />
          </InputGroupAddon>
        </InputGroup>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {filteredChats.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-sm">
            <p>
              {searchQuery.trim()
                ? "No matching chats found."
                : "No chats yet for this project."}
            </p>
          </div>
        ) : (
          <div className="space-y-1 px-2 pb-3">
            {filteredChats.map((chat) => {
              const isActiveChat = chat.id === activeChatId;
              const isOpenChat = projectUi.openChatIds.includes(chat.id);
              const isStreaming = !!streamingChatIds[chat.id];
              const isTitleGenerating = !!titleGeneratingChatIds[chat.id];
              const lastActiveAt = chat.updatedAt || chat.createdAt;

              return (
                <div
                  className={cn(
                    "group relative min-w-0 rounded-md border transition-colors",
                    isActiveChat
                      ? "border-border bg-muted/30"
                      : "border-transparent hover:bg-muted/30",
                  )}
                  key={chat.id}
                >
                  <button
                    className="w-full rounded-[inherit] px-3 py-2 text-left"
                    onClick={(event) => {
                      handleChatSelect(chat.id);
                      onChatSelect?.();
                      if (event.detail > 0) {
                        event.currentTarget.blur();
                      }
                    }}
                    type="button"
                  >
                    <div className="flex min-w-0 items-center gap-2 pr-12">
                      {isStreaming || isTitleGenerating ? (
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Spinner className="size-3 shrink-0" />
                        </div>
                      ) : null}
                      <div className="min-w-0 flex-1">
                        <p
                          className={cn(
                            "min-w-0 truncate text-sm leading-5",
                            isOpenChat && "text-muted-foreground",
                          )}
                        >
                          {chat.title}
                        </p>
                      </div>
                    </div>
                    <span className="-translate-y-1/2 absolute top-1/2 right-3 text-right text-muted-foreground text-xs transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                      {formatLastActiveTime(lastActiveAt)}
                    </span>
                  </button>
                  <div className="-translate-y-1/2 absolute top-1/2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button
                      aria-label={`Delete ${chat.title}`}
                      className="size-7 rounded-md p-0 text-muted-foreground hover:bg-muted hover:text-destructive"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteChat(chat.id);
                      }}
                      size="icon-sm"
                      title="Delete chat"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
};
