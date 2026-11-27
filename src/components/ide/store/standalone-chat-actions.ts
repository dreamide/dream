// Standalone chats (GLOSSARY.md, Standalone chat): creating one, with its
// chat folder made on its Host, and showing one. At most one standalone
// project is open; showing another closes it the way closing a tab does,
// terminals included.
import { apiClient } from "@/lib/api-client";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { ProjectConfig } from "@/types/ide";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import { createHostReach, type HostReach } from "./host-reach";
import type {
  IdeStoreGet,
  IdeStoreSet,
  StoreActionDependencies,
} from "./ide-store-types";
import { commitWorkspaceRemoval } from "./project-runtime-state";
import {
  createTerminalSessionOwner,
  type TerminalSessionOwner,
} from "./terminal-actions";
import * as workspace from "./workspace-document";

/** The standalone chat actions in the store (`IdeState`). */
export interface StandaloneChatActions {
  /**
   * Starts a standalone chat on a Host (the local one by default): shows
   * that Host's empty one again, or creates a chat folder there and a
   * standalone project for it. Not `ok` when the Host could not be reached
   * (`error` null) or refused the folder (`error` as the API threw it).
   */
  createStandaloneChat: (options?: {
    hostId?: string;
  }) => Promise<
    | { ok: true; chatId: string | null; projectId: string }
    | { ok: false; error: unknown }
  >;
  /**
   * Shows a standalone chat, restoring it when deleted. Its project opens
   * and the standalone project that was open closes. False when the chat
   * is not a standalone chat or its Host could not be reached.
   */
  showStandaloneChat: (chatId: string) => Promise<boolean>;
  /**
   * Turns a standalone chat's project into an ordinary one where its folder
   * is, named after the chat, and shows it as its own tab. Its other chats
   * go with it. False when the chat is not a standalone chat.
   */
  promoteStandaloneChat: (chatId: string) => boolean;
}

export const createStandaloneChatActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  {
    api = apiClient,
    reach = createHostReach(get),
    terminals = createTerminalSessionOwner(set, get),
  }: StoreActionDependencies & {
    reach?: Pick<HostReach, "reach">;
    terminals?: Pick<TerminalSessionOwner, "dropProject">;
  } = {},
): StandaloneChatActions => {
  /** A Host other than this machine is connected and loaded first. */
  const reachHost = (hostId: string) => reach.reach(hostId);

  /** Closes the other open standalone project, then shows this one. */
  const show = (
    path: string,
    hostId: string,
    create?: (project: ProjectConfig) => ProjectConfig,
  ) => {
    const state = get();
    const { doc, closedProjectIds, chatId, projectId } =
      workspace.showStandaloneProject(state, state.settings, path, {
        create,
        hostId,
      });
    void commitWorkspaceRemoval(set, terminals, {
      doc,
      closedProjectIds,
      removedProjectIds: [],
      removedChatIds: [],
    });
    return { chatId, projectId };
  };

  return {
    createStandaloneChat: async (options) => {
      const hostId = options?.hostId ?? LOCAL_HOST_ID;
      if (!(await reachHost(hostId))) {
        return { error: null, ok: false };
      }

      const draft = workspace.findStandaloneDraft(get(), hostId);
      if (draft) {
        return { ok: true, ...show(draft.path, hostId) };
      }

      const projectId = crypto.randomUUID();
      let folder: { path: string };
      try {
        folder = await api.createChatFolder({ projectId }, { hostId });
      } catch (error) {
        return { error, ok: false };
      }
      const createdAt = new Date().toISOString();
      return {
        ok: true,
        ...show(folder.path, hostId, (project) => ({
          ...project,
          id: projectId,
          standalone: { createdAt },
        })),
      };
    },

    showStandaloneChat: async (chatId) => {
      const state = get();
      const chat = state.chats.find((item) => item.id === chatId);
      const project = [...state.projects, ...state.closedProjects].find(
        (item) => item.id === chat?.projectId,
      );
      if (!chat || !project?.standalone) return false;
      const hostId = getProjectHostId(project);
      if (!(await reachHost(hostId))) return false;
      if (chat.deletedAt !== null) get().restoreChats([chat.id]);
      show(project.path, hostId);
      get().setActiveChatId(project.id, chat.id);
      return true;
    },

    promoteStandaloneChat: (chatId) => {
      const state = get();
      const chat = state.chats.find((item) => item.id === chatId);
      const project = [...state.projects, ...state.closedProjects].find(
        (item) => item.id === chat?.projectId,
      );
      if (!chat || !project?.standalone) return false;
      set((current) => {
        const promoted = workspace.promoteStandaloneProject(
          current,
          current.settings,
          project.id,
          chat.title,
        );
        return promoted.doc;
      });
      get().setActiveChatId(project.id, chat.id);
      return true;
    },
  };
};
