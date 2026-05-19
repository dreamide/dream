import { FolderGit2, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import type {
  ChatConfig,
  ProjectConfig,
  ProjectGitWorktreeInfo,
  ProjectGitWorktreesResponse,
} from "@/types/ide";
import { normalizeProjectPathKey } from "./ide-state";
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

const readResponseText = async (response: Response) => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

const useAppManagedWorktrees = (projectPath: string, refreshKey: number) => {
  const [worktrees, setWorktrees] = useState<ProjectGitWorktreeInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const abortController = new AbortController();

    const loadWorktrees = async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/project-git-worktrees", {
          body: JSON.stringify({ projectPath }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: abortController.signal,
        });
        if (!response.ok) {
          setWorktrees([]);
          return;
        }

        const payload = (await response.json()) as ProjectGitWorktreesResponse;
        if (abortController.signal.aborted) {
          return;
        }

        setWorktrees(
          payload.worktrees
            .filter((worktree) => worktree.appManaged && !worktree.bare)
            .sort((left, right) =>
              (left.branch ?? left.path).localeCompare(
                right.branch ?? right.path,
              ),
            ),
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setWorktrees([]);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    };

    void refreshKey;
    void loadWorktrees();

    return () => abortController.abort();
  }, [projectPath, refreshKey]);

  return { loading, worktrees };
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
  const completedChatIds = useIdeStore((s) => s.completedChatIds);
  const titleGeneratingChatIds = useIdeStore((s) => s.titleGeneratingChatIds);
  const deleteChat = useIdeStore((s) => s.deleteChat);
  const addProject = useIdeStore((s) => s.addProject);
  const closeProject = useIdeStore((s) => s.closeProject);
  const bumpProjectGitRefreshKey = useIdeStore(
    (s) => s.bumpProjectGitRefreshKey,
  );
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[project.id] ?? 0,
  );
  const { loading: worktreesLoading, worktrees } = useAppManagedWorktrees(
    project.path,
    gitRefreshKey,
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [removingWorktreePath, setRemovingWorktreePath] = useState<
    string | null
  >(null);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);

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

  const handleWorktreeSelect = useCallback(
    (worktreePath: string) => {
      addProject(worktreePath);
      onChatSelect?.();
    },
    [addProject, onChatSelect],
  );

  const purgeWorktreeProjectState = useCallback(
    (worktreePath: string) => {
      const worktreePathKey = normalizeProjectPathKey(worktreePath);
      const state = useIdeStore.getState();
      const openProject = state.projects.find(
        (item) => normalizeProjectPathKey(item.path) === worktreePathKey,
      );
      if (openProject) {
        closeProject(openProject.id);
      }

      useIdeStore.setState((current) => {
        const allRemovedProjects = [
          ...current.projects,
          ...current.closedProjects,
        ].filter(
          (item) => normalizeProjectPathKey(item.path) === worktreePathKey,
        );
        const removedProjectIds = new Set(
          allRemovedProjects.map((item) => item.id),
        );
        if (removedProjectIds.size === 0) {
          return current;
        }

        const removedChatIds = new Set(
          current.chats
            .filter((chat) => removedProjectIds.has(chat.projectId))
            .map((chat) => chat.id),
        );
        const messagesByChatId = { ...current.messagesByChatId };
        for (const chatId of removedChatIds) {
          delete messagesByChatId[chatId];
        }

        return {
          chats: current.chats.filter(
            (chat) => !removedProjectIds.has(chat.projectId),
          ),
          closedProjects: current.closedProjects.filter(
            (item) => normalizeProjectPathKey(item.path) !== worktreePathKey,
          ),
          messagesByChatId,
          projects: current.projects.filter(
            (item) => normalizeProjectPathKey(item.path) !== worktreePathKey,
          ),
        };
      });
      useIdeStore.getState().persist();
    },
    [closeProject],
  );

  const handleRemoveWorktree = useCallback(
    async (worktree: ProjectGitWorktreeInfo) => {
      const branchLabel = worktree.branch ?? worktree.path;
      const confirmed = window.confirm(
        `Remove worktree "${branchLabel}"?\n\nThis removes the worktree folder from disk. Git will refuse if it has uncommitted changes.`,
      );
      if (!confirmed) {
        return;
      }

      setRemovingWorktreePath(worktree.path);
      setWorktreeError(null);
      try {
        const response = await fetch("/api/project-git-worktree-remove", {
          body: JSON.stringify({
            force: false,
            projectPath: project.path,
            worktreePath: worktree.path,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(await readResponseText(response));
        }

        purgeWorktreeProjectState(worktree.path);
        bumpProjectGitRefreshKey(project.id);
      } catch (error) {
        setWorktreeError(
          error instanceof Error ? error.message : "Unable to remove worktree.",
        );
      } finally {
        setRemovingWorktreePath(null);
      }
    },
    [
      bumpProjectGitRefreshKey,
      project.id,
      project.path,
      purgeWorktreeProjectState,
    ],
  );

  const activeProjectPathKey = normalizeProjectPathKey(project.path);

  return (
    <div
      id="projects-panel"
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-lg border border-surface-300 dark:border-surface-700 bg-background shadow-md",
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
        <div className="space-y-4 px-2 pb-3">
          {worktrees.length > 0 || worktreesLoading ? (
            <section className="space-y-1">
              <div className="flex items-center gap-2 px-1 font-medium text-muted-foreground text-xs">
                <FolderGit2 className="size-3.5" />
                Worktrees
              </div>
              {worktrees.map((worktree) => {
                const isActiveWorktree =
                  normalizeProjectPathKey(worktree.path) ===
                  activeProjectPathKey;
                const removing = removingWorktreePath === worktree.path;

                return (
                  <div
                    className={cn(
                      "group relative min-w-0 rounded-md border",
                      isActiveWorktree
                        ? "border-border bg-surface-50 dark:bg-surface-900"
                        : "border-transparent hover:bg-surface-50 dark:hover:bg-surface-900",
                    )}
                    key={worktree.path}
                  >
                    <button
                      className="w-full rounded-[inherit] px-3 py-2 text-left"
                      onClick={(event) => {
                        handleWorktreeSelect(worktree.path);
                        if (event.detail > 0) {
                          event.currentTarget.blur();
                        }
                      }}
                      type="button"
                    >
                      <div className="flex min-w-0 items-center gap-2 pr-9">
                        <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm leading-5">
                            {worktree.branch ?? "Detached worktree"}
                          </p>
                          <p className="truncate text-muted-foreground text-xs">
                            {worktree.path}
                          </p>
                        </div>
                      </div>
                    </button>
                    <div className="-translate-y-1/2 absolute top-1/2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                      <Button
                        aria-label={`Remove ${
                          worktree.branch ?? worktree.path
                        }`}
                        className="size-7 rounded-md p-0 text-muted-foreground hover:bg-muted hover:text-destructive"
                        disabled={removing}
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleRemoveWorktree(worktree);
                        }}
                        size="icon-sm"
                        title="Remove worktree"
                        type="button"
                        variant="ghost"
                      >
                        {removing ? (
                          <Spinner className="size-3.5" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </Button>
                    </div>
                  </div>
                );
              })}
              {worktreeError ? (
                <p className="px-2 text-destructive text-xs">{worktreeError}</p>
              ) : null}
            </section>
          ) : null}

          <section className="space-y-1">
            {filteredChats.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center p-4 text-center text-muted-foreground text-sm">
                <p>
                  {searchQuery.trim()
                    ? "No matching chats found."
                    : "No chats yet for this project."}
                </p>
              </div>
            ) : (
              filteredChats.map((chat) => {
                const isActiveChat = chat.id === activeChatId;
                const isOpenChat = projectUi.openChatIds.includes(chat.id);
                const isStreaming = !!streamingChatIds[chat.id];
                const isTitleGenerating = !!titleGeneratingChatIds[chat.id];
                const isCompleted =
                  Boolean(completedChatIds[chat.id]) &&
                  chat.id !== activeChatId;
                const lastActiveAt = chat.updatedAt || chat.createdAt;
                const statusIndicator = isStreaming ? (
                  <StatusDot aria-label="Chat streaming" color="blue" />
                ) : isCompleted ? (
                  <StatusDot aria-label="Chat finished" color="green" />
                ) : isTitleGenerating ? (
                  <Spinner className="size-3 shrink-0" />
                ) : null;

                return (
                  <div
                    className={cn(
                      "group relative min-w-0 rounded-md border",
                      isActiveChat
                        ? "border-border bg-surface-50 dark:bg-surface-900"
                        : "border-transparent hover:bg-surface-50 dark:hover:bg-surface-900",
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
                        {statusIndicator ? (
                          <div className="flex size-4 shrink-0 items-center justify-center">
                            {statusIndicator}
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
                      <span className="-translate-y-1/2 absolute top-1/2 right-3 text-right text-muted-foreground text-xs group-hover:opacity-0 group-focus-within:opacity-0">
                        {formatLastActiveTime(lastActiveAt)}
                      </span>
                    </button>
                    <div className="-translate-y-1/2 absolute top-1/2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
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
              })
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  );
};
