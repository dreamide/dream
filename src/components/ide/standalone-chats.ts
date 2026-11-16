// The Chats tab's side of standalone chats (GLOSSARY.md, Standalone chat):
// which chats it lists, what activating it shows, and starting one from any
// entry point. The store's standalone chat actions do the work.
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { toast } from "sonner";
import { getApiErrorMessage } from "@/lib/api-client";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { useIdeStore } from "./ide-store";

/** The Chats tab's id in the tab strip; it stands for the open standalone project. */
export const CHATS_TAB_ID = "standalone-chats";

const byPinnedThenRecent = (left: ChatConfig, right: ChatConfig) => {
  const pinnedOrder = Number(right.pinned) - Number(left.pinned);
  if (pinnedOrder !== 0) return pinnedOrder;
  const leftUpdated = Date.parse(left.updatedAt || left.createdAt);
  const rightUpdated = Date.parse(right.updatedAt || right.createdAt);
  if (Number.isNaN(leftUpdated) || Number.isNaN(rightUpdated)) {
    return right.title.localeCompare(left.title);
  }
  return rightUpdated - leftUpdated;
};

/** Every standalone project, open or closed, by id. */
export const standaloneProjectsById = (
  projects: ProjectConfig[],
  closedProjects: ProjectConfig[],
) =>
  new Map(
    [...projects, ...closedProjects]
      .filter((project) => project.standalone)
      .map((project) => [project.id, project]),
  );

/**
 * The standalone chats the Chats tab lists, on every Host: live ones that
 * have messages (or are pinned), pinned first, then the most recent.
 */
export const listStandaloneChats = (
  chats: ChatConfig[],
  standaloneProjects: Map<string, ProjectConfig>,
) =>
  chats
    .filter(
      (chat) =>
        standaloneProjects.has(chat.projectId) &&
        chat.deletedAt === null &&
        (chat.messageCount > 0 || chat.pinned),
    )
    .sort(byPinnedThenRecent);

/** Starts a standalone chat on a Host, with a toast when it cannot. */
export const useStartStandaloneChat = () => {
  const t = useTranslations("projects");
  return useCallback(
    async (hostId?: string) => {
      const result = await useIdeStore
        .getState()
        .createStandaloneChat({ hostId });
      // An unreachable Host has already said so.
      if (!result.ok && result.error !== null) {
        toast.error(getApiErrorMessage(result.error, t("unableToStartChat")));
      }
      return result.ok;
    },
    [t],
  );
};

/**
 * What activating the Chats tab shows: the open standalone project, else
 * the most recent standalone chat, else a new one on the local Host.
 */
export const useOpenChatsTab = () => {
  const startChat = useStartStandaloneChat();
  return useCallback(async () => {
    const state = useIdeStore.getState();
    const open = state.projects.find((project) => project.standalone);
    if (open) {
      state.setActiveProjectId(open.id);
      return;
    }
    const [latest] = listStandaloneChats(
      state.chats,
      standaloneProjectsById(state.projects, state.closedProjects),
    );
    if (latest && (await state.showStandaloneChat(latest.id))) return;
    await startChat();
  }, [startChat]);
};
