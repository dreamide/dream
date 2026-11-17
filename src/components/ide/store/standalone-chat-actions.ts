// Standalone chats (GLOSSARY.md, Standalone chat): creating one, with its
// chat folder made on its Host, and showing one. At most one standalone
// project is open; showing another closes it the way closing a tab does,
// terminals included.
import { apiClient } from "@/lib/api-client";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { ProjectConfig } from "@/types/ide";
import {
  getProjectHostId,
  normalizeProjectPathKey,
} from "../../../../electron/shared/persisted-state-codec.js";
import { createHostReach, type HostReach } from "./host-reach";
import type {
  IdeState,
  IdeStoreGet,
  IdeStoreSet,
  StoreActionDependencies,
} from "./ide-store-types";
import * as workspace from "./workspace-document";

export const createStandaloneChatActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
  {
    api = apiClient,
    reach = createHostReach(get),
  }: StoreActionDependencies & { reach?: Pick<HostReach, "reach"> } = {},
): Pick<
  IdeState,
  "createStandaloneChat" | "showStandaloneChat" | "promoteStandaloneChat"
> => {
  /** A Host other than this machine is connected and loaded first. */
  const reachHost = (hostId: string) => reach.reach(hostId);

  /** Closes the other open standalone project, then shows this one. */
  const show = (
    path: string,
    hostId: string,
    create?: (project: ProjectConfig) => ProjectConfig,
  ) => {
    for (const project of get().projects) {
      if (
        project.standalone &&
        !(
          getProjectHostId(project) === hostId &&
          normalizeProjectPathKey(project.path) ===
            normalizeProjectPathKey(path)
        )
      ) {
        get().closeProject(project.id);
      }
    }
    let shown: { chatId: string | null; projectId: string } = {
      chatId: null,
      projectId: "",
    };
    set((state) => {
      const result = workspace.showStandaloneProject(
        state,
        state.settings,
        path,
        { create, hostId },
      );
      shown = result;
      return result.doc;
    });
    return shown;
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
