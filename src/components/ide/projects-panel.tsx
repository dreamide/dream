import {
  Archive,
  FolderInput,
  FolderTree,
  FolderX,
  MessageSquarePlus,
  Pin,
  PinOff,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { getClientPlatform } from "@/lib/connections/platform";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { cn } from "@/lib/utils";
import type {
  ChatConfig,
  ProjectConfig,
  ProjectGitWorktreeInfo,
} from "@/types/ide";
import { getProjectHostId } from "../../../electron/shared/persisted-state-codec.js";
import { formatLastActiveTime } from "./activity-time";
import {
  isChatRunning,
  isChatWaitingOnUser,
  selectChatActivity,
} from "./chat-activity";
import { RemoveWorktreeDialog } from "./git-actions/remove-worktree-dialog";
import { normalizeProjectPathKey } from "./ide-state";
import { useIdeStore } from "./ide-store";
import { projectResourceKey, useProjectResource } from "./project-resources";
import { useHostChoices } from "./ssh/use-host-choices";
import {
  listStandaloneChats,
  standaloneProjectsById,
  useStartStandaloneChat,
} from "./standalone-chats";

type WorktreeRepoPaths = { mainWorktreePath: string; repoRoot: string };

/** The project's app-managed worktrees, read while the sidebar is shown. */
const useAppManagedWorktrees = (project: ProjectConfig, visible: boolean) => {
  const resource = useProjectResource(
    projectResourceKey("gitWorktrees", project.path, {
      hostId: getProjectHostId(project),
    }),
    { active: visible },
  );
  const payload = resource.error === undefined ? resource.data : undefined;
  const repoPaths = useMemo<WorktreeRepoPaths | null>(
    () =>
      payload?.repoRoot && payload.mainWorktreePath
        ? {
            mainWorktreePath: payload.mainWorktreePath,
            repoRoot: payload.repoRoot,
          }
        : null,
    [payload],
  );
  const worktrees = useMemo<ProjectGitWorktreeInfo[]>(
    () =>
      // Not a repository, or git failed: no worktrees to list.
      (payload?.worktrees ?? [])
        .filter((worktree) => worktree.appManaged && !worktree.bare)
        .sort((left, right) =>
          (left.branch ?? left.path).localeCompare(right.branch ?? right.path),
        ),
    [payload],
  );

  return { loading: resource.loading, repoPaths, worktrees };
};

export const ProjectSidebar = ({
  className,
  onChatSelect,
  project,
  visible = true,
}: {
  className?: string;
  onChatSelect?: () => void;
  project: ProjectConfig;
  /** Whether the sidebar is on screen; its worktrees are read only then. */
  visible?: boolean;
}) => {
  const locale = useLocale();
  const projectsT = useTranslations("projects");
  const panelsT = useTranslations("panels");
  const worktreeT = useTranslations("worktrees");
  const sshT = useTranslations("sshHosts");
  const relativeTimeFormatter = useMemo(
    () =>
      new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" }),
    [locale],
  );
  const allChats = useIdeStore((s) => s.chats);
  const projectUi = useIdeStore(
    (s) => s.projects.find((item) => item.id === project.id)?.ui ?? project.ui,
  );
  const setActiveChatId = useIdeStore((s) => s.setActiveChatId);
  const showStandaloneChat = useIdeStore((s) => s.showStandaloneChat);
  const promoteStandaloneChat = useIdeStore((s) => s.promoteStandaloneChat);
  const openProjects = useIdeStore((s) => s.projects);
  const closedProjects = useIdeStore((s) => s.closedProjects);
  const hosts = useIdeStore((s) => s.hosts);
  const hostChoices = useHostChoices();
  const startStandaloneChat = useStartStandaloneChat();
  // A standalone project's sidebar is the Chats tab's: the standalone chats
  // of every Host.
  const standaloneProjects = useMemo(
    () =>
      project.standalone
        ? standaloneProjectsById(openProjects, closedProjects)
        : null,
    [closedProjects, openProjects, project.standalone],
  );
  const hostLabels = useMemo(
    () => new Map(hostChoices.map((host) => [host.id, host.label])),
    [hostChoices],
  );
  /** Hosts a standalone chat can be started on besides this machine. */
  const otherConnectedHosts = useMemo(
    () => hostChoices.filter((host) => hosts[host.id]?.state === "connected"),
    [hostChoices, hosts],
  );
  const activity = useIdeStore(useShallow(selectChatActivity));
  const completedChatIds = useIdeStore((s) => s.completedChatIds);
  const titleGeneratingChatIds = useIdeStore((s) => s.titleGeneratingChatIds);
  const deleteChat = useIdeStore((s) => s.deleteChat);
  const toggleChatPinned = useIdeStore((s) => s.toggleChatPinned);
  const addProject = useIdeStore((s) => s.addProject);
  const attachWorktreeProject = useIdeStore((s) => s.attachWorktreeProject);
  const {
    loading: worktreesLoading,
    repoPaths,
    worktrees,
  } = useAppManagedWorktrees(project, visible && !project.standalone);

  const [searchQuery, setSearchQuery] = useState("");
  const [pendingRemoveWorktree, setPendingRemoveWorktree] =
    useState<ProjectGitWorktreeInfo | null>(null);

  const activeProjectChats = useMemo<ChatConfig[]>(() => {
    if (standaloneProjects) {
      return listStandaloneChats(allChats, standaloneProjects);
    }
    return allChats
      .filter(
        (chat) =>
          chat.projectId === project.id &&
          chat.deletedAt === null &&
          (chat.messageCount > 0 || chat.pinned),
      )
      .sort((left, right) => {
        const pinnedOrder =
          Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
        if (pinnedOrder !== 0) return pinnedOrder;
        const leftUpdated = Date.parse(left.updatedAt);
        const rightUpdated = Date.parse(right.updatedAt);
        if (Number.isNaN(leftUpdated) || Number.isNaN(rightUpdated)) {
          return right.title.localeCompare(left.title);
        }

        return rightUpdated - leftUpdated;
      });
  }, [allChats, project.id, standaloneProjects]);

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
    (chat: ChatConfig) => {
      if (chat.projectId !== project.id && project.standalone) {
        void showStandaloneChat(chat.id);
        return;
      }
      setActiveChatId(project.id, chat.id);
    },
    [project.id, project.standalone, setActiveChatId, showStandaloneChat],
  );

  const handleWorktreeSelect = useCallback(
    (worktree: ProjectGitWorktreeInfo) => {
      // Open it as a worktree project, so it gets the worktree footer and the
      // Complete worktree action, rather than as a plain folder.
      if (repoPaths) {
        attachWorktreeProject(worktree, {
          ...repoPaths,
          hostId: project.hostId,
        });
      } else {
        addProject(worktree.path, { hostId: project.hostId });
      }
      onChatSelect?.();
    },
    [
      addProject,
      attachWorktreeProject,
      onChatSelect,
      project.hostId,
      repoPaths,
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
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-sm">
            {project.standalone ? projectsT("chats") : projectsT("chatHistory")}
          </p>
          {project.standalone && otherConnectedHosts.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label={projectsT("newChatOn")}
                    className="text-muted-foreground hover:text-foreground"
                    size="icon-sm"
                    title={projectsT("newChatOn")}
                    type="button"
                    variant="ghost"
                  />
                }
              >
                <MessageSquarePlus className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    void startStandaloneChat();
                    onChatSelect?.();
                  }}
                >
                  {getClientPlatform().kind === "web"
                    ? getClientPlatform().homeLabel
                    : sshT("localMachine")}
                </DropdownMenuItem>
                {otherConnectedHosts.map((host) => (
                  <DropdownMenuItem
                    key={host.id}
                    onClick={() => {
                      void startStandaloneChat(host.id);
                      onChatSelect?.();
                    }}
                  >
                    {host.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        <SearchInput
          className="mt-2"
          clearLabel={panelsT("clearSearch")}
          onValueChange={setSearchQuery}
          placeholder={projectsT("searchHistory")}
          value={searchQuery}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-2 pb-3">
          {worktrees.length > 0 || worktreesLoading ? (
            <section className="space-y-1">
              <div className="flex items-center gap-2 px-1 font-medium text-muted-foreground text-sm">
                <FolderTree className="size-3.5" />
                {worktreeT("worktrees")}
              </div>
              {worktrees.map((worktree) => {
                const isActiveWorktree =
                  normalizeProjectPathKey(worktree.path) ===
                  activeProjectPathKey;

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
                        handleWorktreeSelect(worktree);
                        if (event.detail > 0) {
                          event.currentTarget.blur();
                        }
                      }}
                      type="button"
                    >
                      <div className="flex min-w-0 items-center gap-2 pr-9">
                        <FolderTree className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm leading-5">
                            {worktree.branch ?? worktreeT("detachedWorktree")}
                          </p>
                          <p className="truncate text-muted-foreground text-sm">
                            {worktree.path}
                          </p>
                        </div>
                      </div>
                    </button>
                    <div className="-translate-y-1/2 absolute top-1/2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                      <Button
                        aria-label={worktreeT("removeNamedWorktree", {
                          name: worktree.branch ?? worktree.path,
                        })}
                        className="size-7 rounded-md p-0 text-muted-foreground hover:bg-muted hover:text-destructive"
                        onClick={(event) => {
                          event.stopPropagation();
                          setPendingRemoveWorktree(worktree);
                        }}
                        size="icon-sm"
                        title={worktreeT("removeWorktree")}
                        type="button"
                        variant="ghost"
                      >
                        <FolderX className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </section>
          ) : null}

          <section className="space-y-1">
            {filteredChats.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center p-4 text-center text-muted-foreground text-sm">
                <p>
                  {searchQuery.trim()
                    ? projectsT("noMatchingChats")
                    : project.standalone
                      ? projectsT("noStandaloneChats")
                      : projectsT("noChatsForProject")}
                </p>
              </div>
            ) : (
              filteredChats.map((chat) => {
                const isActiveChat = chat.id === activeChatId;
                const isOpenChat = projectUi.openChatIds.includes(chat.id);
                // Running or waiting, here or on the host, whether or not
                // this window follows the turn (chat-activity.ts).
                const isRunning = isChatRunning(activity, chat.id);
                const isAwaiting = isChatWaitingOnUser(activity, chat.id);
                const isTitleGenerating = !!titleGeneratingChatIds[chat.id];
                const isCompleted =
                  Boolean(completedChatIds[chat.id]) &&
                  chat.id !== activeChatId;
                const lastActiveAt = chat.updatedAt || chat.createdAt;
                // Standalone chats of every Host share one list: a chat on
                // another Host says which.
                const chatProject = standaloneProjects?.get(chat.projectId);
                const chatHostId = chatProject
                  ? getProjectHostId(chatProject)
                  : null;
                // Once it has had a turn, its folder can become a project.
                const canPromote =
                  Boolean(chatProject) && chat.messageCount > 0;
                const statusIndicator = isAwaiting ? (
                  <StatusDot
                    aria-label={projectsT("chatAwaitingApproval")}
                    color="amber"
                    pulse
                  />
                ) : isRunning ? (
                  <Spinner
                    aria-label={projectsT("chatStreaming")}
                    className="size-3 shrink-0"
                  />
                ) : isCompleted ? (
                  <StatusDot
                    aria-label={projectsT("chatFinished")}
                    color="green"
                  />
                ) : isTitleGenerating ? (
                  <Spinner className="size-3 shrink-0" />
                ) : null;

                return (
                  <div
                    className={cn(
                      "group relative min-w-0 rounded-md border border-transparent",
                      isActiveChat || isOpenChat || isRunning
                        ? "bg-muted"
                        : "hover:bg-surface-50 dark:hover:bg-surface-900",
                    )}
                    key={chat.id}
                  >
                    <button
                      className="w-full rounded-[inherit] px-3 py-2 text-left"
                      onClick={(event) => {
                        handleChatSelect(chat);
                        onChatSelect?.();
                        if (event.detail > 0) {
                          event.currentTarget.blur();
                        }
                      }}
                      type="button"
                    >
                      <div
                        className={cn(
                          "flex min-w-0 items-center gap-2",
                          canPromote ? "pr-24" : "pr-16",
                        )}
                      >
                        {chat.pinned ? (
                          <Pin
                            aria-label={projectsT("pinnedChat")}
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                        ) : null}
                        {statusIndicator ? (
                          <div className="flex size-4 shrink-0 items-center justify-center">
                            {statusIndicator}
                          </div>
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <p className="min-w-0 truncate text-sm leading-5">
                            {chat.title}
                          </p>
                          {chatHostId && chatHostId !== LOCAL_HOST_ID ? (
                            <p className="min-w-0 truncate text-muted-foreground text-xs">
                              {hostLabels.get(chatHostId) ?? chatHostId}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <span className="-translate-y-1/2 absolute top-1/2 right-3 text-right text-muted-foreground text-xs group-hover:opacity-0 group-focus-within:opacity-0">
                        {formatLastActiveTime(
                          lastActiveAt,
                          relativeTimeFormatter,
                        )}
                      </span>
                    </button>
                    <div className="-translate-y-1/2 absolute top-1/2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                      {canPromote ? (
                        <Button
                          aria-label={projectsT("turnNamedIntoProject", {
                            name: chat.title,
                          })}
                          className="size-7 rounded-md p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={(event) => {
                            event.stopPropagation();
                            promoteStandaloneChat(chat.id);
                            onChatSelect?.();
                          }}
                          size="icon-sm"
                          title={projectsT("turnIntoProject")}
                          type="button"
                          variant="ghost"
                        >
                          <FolderInput className="size-3.5" />
                        </Button>
                      ) : null}
                      <Button
                        aria-label={projectsT(
                          chat.pinned ? "unpinNamedChat" : "pinNamedChat",
                          { name: chat.title },
                        )}
                        aria-pressed={chat.pinned}
                        className="size-7 rounded-md p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (event.detail > 0) {
                            event.currentTarget.blur();
                          }
                          toggleChatPinned(chat.id);
                        }}
                        size="icon-sm"
                        title={projectsT(chat.pinned ? "unpinChat" : "pinChat")}
                        type="button"
                        variant="ghost"
                      >
                        {chat.pinned ? (
                          <PinOff className="size-3.5" />
                        ) : (
                          <Pin className="size-3.5" />
                        )}
                      </Button>
                      <Button
                        aria-label={projectsT("archiveNamedChat", {
                          name: chat.title,
                        })}
                        className="size-7 rounded-md p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={(event) => {
                          event.stopPropagation();
                          deleteChat(chat.id);
                        }}
                        size="icon-sm"
                        title={projectsT("archiveChat")}
                        type="button"
                        variant="ghost"
                      >
                        <Archive className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </section>
        </div>
      </ScrollArea>
      {pendingRemoveWorktree ? (
        <RemoveWorktreeDialog
          onClose={() => setPendingRemoveWorktree(null)}
          project={project}
          worktree={pendingRemoveWorktree}
        />
      ) : null}
    </div>
  );
};
