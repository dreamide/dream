import { Ellipsis, FilePenLine, Search, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
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
  const draftChatIdByProject = useIdeStore((s) => s.draftChatIdByProject);
  const messagesByChatId = useIdeStore((s) => s.messagesByChatId);
  const setActiveChatId = useIdeStore((s) => s.setActiveChatId);
  const streamingChatIds = useIdeStore((s) => s.streamingChatIds);
  const updateChat = useIdeStore((s) => s.updateChat);
  const deleteChat = useIdeStore((s) => s.deleteChat);

  const [searchQuery, setSearchQuery] = useState("");
  const [editTarget, setEditTarget] = useState<ChatConfig | null>(null);
  const [editValue, setEditValue] = useState("");

  const activeProjectChats = useMemo<ChatConfig[]>(() => {
    const draftChatId = draftChatIdByProject[project.id] ?? null;
    return allChats
      .filter(
        (chat) => chat.projectId === project.id && chat.deletedAt === null,
      )
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
  }, [allChats, draftChatIdByProject, messagesByChatId, project.id]);

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

  const closeEditDialog = useCallback(() => {
    setEditTarget(null);
    setEditValue("");
  }, []);

  const handleEditSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const nextName = editValue.trim();
      if (!editTarget || !nextName) {
        return;
      }

      updateChat(editTarget.id, (current) => ({
        ...current,
        title: nextName,
      }));
      closeEditDialog();
    },
    [closeEditDialog, editTarget, editValue, updateChat],
  );

  return (
    <>
      <div
        id="projects-panel"
        className={cn(
          "flex h-full flex-col overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md",
          className,
        )}
      >
        <div className="px-3 py-3">
          <p className="font-medium text-sm">Chat history</p>
          <InputGroup className="mt-2 h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
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
                const isStreaming = !!streamingChatIds[chat.id];
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
                        setActiveChatId(project.id, chat.id);
                        onChatSelect?.();
                        if (event.detail > 0) {
                          event.currentTarget.blur();
                        }
                      }}
                      type="button"
                    >
                      <div className="flex min-w-0 items-center gap-2 pr-14">
                        {isStreaming ? (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <Spinner className="size-3 shrink-0" />
                          </div>
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <p className="min-w-0 truncate text-sm leading-5">
                            {chat.title}
                          </p>
                        </div>
                      </div>
                      <span className="-translate-y-1/2 absolute top-1/2 right-3 text-right text-muted-foreground text-xs transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                        {formatLastActiveTime(lastActiveAt)}
                      </span>
                    </button>
                    <div className="-translate-y-1/2 absolute top-1/2 right-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              aria-label={`${chat.title} actions`}
                              className="size-7 rounded-md p-0 text-muted-foreground hover:bg-transparent hover:text-foreground"
                              size="icon-sm"
                              title="Chat actions"
                              type="button"
                              variant="ghost"
                            />
                          }
                        >
                          <Ellipsis className="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          <DropdownMenuItem
                            onClick={() => {
                              setEditTarget(chat);
                              setEditValue(chat.title);
                            }}
                          >
                            <FilePenLine className="size-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => {
                              if (editTarget?.id === chat.id) {
                                closeEditDialog();
                              }
                              deleteChat(chat.id);
                            }}
                          >
                            <Trash2 className="size-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            closeEditDialog();
          }
        }}
        open={editTarget !== null}
      >
        <DialogContent className="sm:max-w-sm">
          <form className="space-y-4" onSubmit={handleEditSubmit}>
            <DialogHeader>
              <DialogTitle className="text-base leading-6">
                Edit chat
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="projects-panel-edit-chat-name">Name</Label>
              <Input
                autoFocus
                id="projects-panel-edit-chat-name"
                onChange={(event) => setEditValue(event.target.value)}
                placeholder="Enter a name"
                value={editValue}
              />
            </div>
            <DialogFooter>
              <Button onClick={closeEditDialog} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={editValue.trim().length === 0} type="submit">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
