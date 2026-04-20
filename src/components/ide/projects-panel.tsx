import {
  Archive,
  Ellipsis,
  ExternalLink,
  FilePenLine,
  MessageSquarePlus,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import type { DetectedEditor } from "@/types/ide";
import { getChatsForProject } from "./ide-state";
import { useIdeStore } from "./ide-store";

type RenameTarget =
  | { id: string; kind: "project"; name: string }
  | { id: string; kind: "chat"; name: string };

const useDetectedEditors = () => {
  const [editors, setEditors] = useState<DetectedEditor[]>([]);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api) return;
    void api.detectEditors().then(setEditors);
  }, []);

  return editors;
};

const ProjectActionsMenu = ({
  editors,
  label,
  onClose,
  onEdit,
  onOpenChange,
  onOpenIn,
  open,
}: {
  editors: DetectedEditor[];
  label: string;
  onClose: () => void;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
  onOpenIn: (editorId: string) => void;
  open: boolean;
}) => {
  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`${label} actions`}
            className="h-8 w-8 p-0"
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <Ellipsis className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={onEdit}>
          <FilePenLine className="size-4" />
          Edit
        </DropdownMenuItem>
        {editors.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ExternalLink className="size-4" />
              Open in
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {editors.map((editor) => (
                <DropdownMenuItem
                  key={editor.id}
                  onClick={() => onOpenIn(editor.id)}
                >
                  {editor.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onClose}>
          <X className="size-4" />
          Close
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const ChatActionsMenu = ({
  label,
  onArchive,
  onEdit,
  onOpenChange,
  open,
}: {
  label: string;
  onArchive: () => void;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) => {
  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`${label} actions`}
            className="h-8 w-8 p-0"
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <Ellipsis className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuItem onClick={onEdit}>
          <FilePenLine className="size-4" />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onArchive}>
          <Archive className="size-4" />
          Archive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export const ProjectSidebar = () => {
  const projects = useIdeStore((s) => s.projects);
  const allChats = useIdeStore((s) => s.chats);
  const activeProject = useIdeStore((s) => s.getActiveProject());
  const activeChatIdByProject = useIdeStore((s) => s.activeChatIdByProject);
  const addChat = useIdeStore((s) => s.addChat);
  const setActiveChatId = useIdeStore((s) => s.setActiveChatId);
  const closeProject = useIdeStore((s) => s.closeProject);
  const updateProject = useIdeStore((s) => s.updateProject);
  const updateChat = useIdeStore((s) => s.updateChat);
  const archiveChat = useIdeStore((s) => s.archiveChat);
  const streamingChatIds = useIdeStore((s) => s.streamingChatIds);
  const detectedEditors = useDetectedEditors();

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const activeProjectChats = useMemo(
    () => (activeProject ? getChatsForProject(allChats, activeProject.id) : []),
    [activeProject, allChats],
  );

  const activeChatId = activeProject
    ? (activeChatIdByProject[activeProject.id] ?? null)
    : null;

  const openRenameDialog = (target: RenameTarget) => {
    setRenameTarget(target);
    setRenameValue(target.name);
  };

  const closeRenameDialog = () => {
    setRenameTarget(null);
    setRenameValue("");
  };

  const handleRenameSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextName = renameValue.trim();
    if (!renameTarget || !nextName) {
      return;
    }

    if (renameTarget.kind === "project") {
      updateProject(renameTarget.id, (current) => ({
        ...current,
        name: nextName,
      }));
    } else {
      updateChat(renameTarget.id, (current) => ({
        ...current,
        title: nextName,
      }));
    }

    closeRenameDialog();
  };

  return (
    <>
      <div
        id="projects-panel"
        className="flex h-full flex-col overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md"
      >
        {activeProject ? (
          <div className="flex items-center justify-between gap-2 px-2 py-2">
            <div className="min-w-0 px-1">
              <p className="truncate font-medium text-sm">
                {activeProject.name}
              </p>
              <p className="truncate text-muted-foreground text-xs">
                {activeProject.path}
              </p>
            </div>

            <div className="flex items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                       aria-label="New chat"
                       className="h-8 w-8 p-0"
                       onClick={() => addChat(activeProject.id)}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    />
                  }
                >
                  <MessageSquarePlus className="size-4" />
                </TooltipTrigger>
                <TooltipContent>New chat</TooltipContent>
              </Tooltip>

              <ProjectActionsMenu
                editors={detectedEditors}
                label={activeProject.name}
                onEdit={() =>
                  openRenameDialog({
                    id: activeProject.id,
                    kind: "project",
                    name: activeProject.name,
                  })
                }
                onClose={() => closeProject(activeProject.id)}
                onOpenChange={(open) =>
                  setOpenMenuId(open ? `project:${activeProject.id}` : null)
                }
                onOpenIn={(editorId) => {
                  const api = getDesktopApi();
                  if (api) {
                    void api.openInEditor({
                      projectPath: activeProject.path,
                      editorId,
                    });
                  }
                }}
                open={openMenuId === `project:${activeProject.id}`}
              />
            </div>
          </div>
        ) : null}

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
            ) : (
              activeProjectChats.map((chat) => {
                const isActiveChat = chat.id === activeChatId;
                const chatMenuId = `chat:${chat.id}`;
                const isChatMenuOpen = openMenuId === chatMenuId;
                const isStreaming = !!streamingChatIds[chat.id];

                return (
                  <div
                    className={cn(
                      "group relative min-w-0 rounded-md transition-colors",
                      isActiveChat
                        ? "border-2 border-border bg-muted/30"
                        : "border-2 border-transparent hover:bg-muted/30",
                    )}
                    key={chat.id}
                  >
                    <button
                      className="w-full rounded-[inherit] px-2 py-1.5 text-left"
                      onClick={() => setActiveChatId(activeProject.id, chat.id)}
                      type="button"
                    >
                      <div className="flex min-w-0 items-center gap-1.5 pr-6">
                        {isStreaming && <Spinner className="size-3 shrink-0" />}
                        <p className="truncate text-sm">{chat.title}</p>
                      </div>
                    </button>
                    <div
                      className={cn(
                        "absolute top-1/2 right-1.5 -translate-y-1/2 transition-opacity",
                        isChatMenuOpen
                          ? "opacity-100"
                          : "opacity-0 group-hover:opacity-100",
                      )}
                    >
                      <ChatActionsMenu
                        label={chat.title}
                        onArchive={() => archiveChat(chat.id)}
                        onEdit={() =>
                          openRenameDialog({
                            id: chat.id,
                            kind: "chat",
                            name: chat.title,
                          })
                        }
                        onOpenChange={(open) =>
                          setOpenMenuId(open ? chatMenuId : null)
                        }
                        open={isChatMenuOpen}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            closeRenameDialog();
          }
        }}
        open={renameTarget !== null}
      >
        <DialogContent className="sm:max-w-sm">
          <form className="space-y-4" onSubmit={handleRenameSubmit}>
            <DialogHeader>
              <DialogTitle>
                 Rename {renameTarget?.kind === "project" ? "project" : "chat"}
               </DialogTitle>
               <DialogDescription>
                 Choose a new name for this{" "}
                 {renameTarget?.kind === "project" ? "project" : "chat"}.
               </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder="Enter a name"
              value={renameValue}
            />
            <DialogFooter>
              <Button
                onClick={closeRenameDialog}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={renameValue.trim().length === 0} type="submit">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
