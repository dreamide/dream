import { Archive, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { ChatConfig } from "@/types/ide";
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

export const ProjectSidebar = () => {
  const projects = useIdeStore((s) => s.projects);
  const allChats = useIdeStore((s) => s.chats);
  const activeProject = useIdeStore((s) => s.getActiveProject());
  const activeChatIdByProject = useIdeStore((s) => s.activeChatIdByProject);
  const draftChatIdByProject = useIdeStore((s) => s.draftChatIdByProject);
  const messagesByChatId = useIdeStore((s) => s.messagesByChatId);
  const setActiveChatId = useIdeStore((s) => s.setActiveChatId);
  const streamingChatIds = useIdeStore((s) => s.streamingChatIds);

  const [searchQuery, setSearchQuery] = useState("");

  const activeProjectChats = useMemo<ChatConfig[]>(() => {
    if (!activeProject) {
      return [];
    }

    const draftChatId = draftChatIdByProject[activeProject.id] ?? null;
    return allChats
      .filter((chat) => chat.projectId === activeProject.id)
      .filter((chat) => {
        if (chat.id !== draftChatId) {
          return true;
        }

        return (messagesByChatId[chat.id]?.length ?? 0) > 0;
      })
      .sort((left, right) => {
        const leftUpdated = Date.parse(left.updatedAt);
        const rightUpdated = Date.parse(right.updatedAt);
        if (Number.isNaN(leftUpdated) || Number.isNaN(rightUpdated)) {
          return right.title.localeCompare(left.title);
        }

        return rightUpdated - leftUpdated;
      });
  }, [activeProject, allChats, draftChatIdByProject, messagesByChatId]);

  const filteredChats = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return activeProjectChats;
    }

    return activeProjectChats.filter((chat) =>
      chat.title.toLowerCase().includes(query),
    );
  }, [activeProjectChats, searchQuery]);

  const activeChatId = activeProject
    ? (activeChatIdByProject[activeProject.id] ?? null)
    : null;

  return (
    <div
      id="projects-panel"
      className="flex h-full flex-col overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md"
    >
      <div className="px-3 py-3">
        <p className="font-medium text-sm">Chat history</p>
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 border-foreground/10 pl-8 text-sm"
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search history..."
            value={searchQuery}
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 px-2 pb-3">
          {projects.length === 0 ? (
            <p className="rounded-md p-3 text-muted-foreground text-xs">
              Add a folder to start working on multiple projects in one
              workspace.
            </p>
          ) : !activeProject ? (
            <p className="rounded-md p-3 text-muted-foreground text-xs">
              Select a project tab to view its chats.
            </p>
          ) : filteredChats.length === 0 ? (
            <p className="rounded-md p-3 text-muted-foreground text-xs">
              {searchQuery.trim()
                ? "No matching chats found."
                : "No chats yet for this project."}
            </p>
          ) : (
            filteredChats.map((chat) => {
              const isActiveChat = chat.id === activeChatId;
              const isStreaming = !!streamingChatIds[chat.id];
              const isArchived = chat.archivedAt !== null;
              const lastActiveAt = chat.updatedAt || chat.createdAt;

              return (
                <div
                  className={cn(
                    "relative min-w-0 rounded-md transition-colors",
                    isActiveChat
                      ? "border-2 border-border bg-muted/30"
                      : "border-2 border-transparent hover:bg-muted/30",
                    isArchived && !isActiveChat && "opacity-80",
                  )}
                  key={chat.id}
                >
                  <button
                    className="w-full rounded-[inherit] px-2 py-1.5 text-left"
                    onClick={() => setActiveChatId(activeProject.id, chat.id)}
                    type="button"
                  >
                    <div className="flex min-w-0 items-start gap-2">
                      <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
                        {isStreaming ? (
                          <Spinner className="size-3 shrink-0" />
                        ) : null}
                        {isArchived ? (
                          <Archive className="size-3 shrink-0 text-muted-foreground" />
                        ) : null}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="min-w-0 flex-1 truncate text-sm">
                            {chat.title}
                          </p>
                          <span className="ml-auto shrink-0 text-right text-muted-foreground text-xs">
                            {formatLastActiveTime(lastActiveAt)}
                          </span>
                        </div>
                        {isArchived ? (
                          <p className="mt-0.5 truncate text-[11px] text-muted-foreground uppercase tracking-wide">
                            Archived
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </button>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
};
