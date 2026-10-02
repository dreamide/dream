/**
 * Applying hosts' catalogs to the store: what another client (or the host
 * itself, running a turn) changed arrives as catalog events and lands here,
 * as does an SSH host's whole catalog when it connects. Workspace fields
 * (open or closed, per-project UI) stay this window's; a project another
 * client added arrives closed. Every project is stamped with its host,
 * which a host's own catalog does not say.
 */
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import {
  decodePersistedState,
  ensureActiveProject,
  getProjectHostId,
  mergeWorkspaceAndCatalog,
} from "../../../../electron/shared/persisted-state-codec.js";
import {
  getCatalogSync,
  getLoadedWorkspace,
  loadCatalog,
  loadPersistedChatMessages,
  markHostLoaded,
} from "./ide-store-persistence";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

type RawRecord = Record<string, unknown>;

const isRecordWithId = (value: unknown): value is RawRecord & { id: string } =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as RawRecord).id === "string";

const withHost = (project: RawRecord, hostId: string): RawRecord =>
  hostId === LOCAL_HOST_ID ? project : { ...project, hostId };

export const createCatalogActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "adoptHostProjects"
  | "applyCatalogChanges"
  | "applyCatalogTranscript"
  | "reloadCatalog"
  | "loadHostCatalog"
  | "setHostTurnRunning"
> => {
  /** Repairs raw projects and chats with the codec and sets them. */
  const applyDecoded = ({
    projects,
    closedProjects,
    chats,
    removedProjectIds = new Set<string>(),
  }: {
    projects: unknown[];
    closedProjects: unknown[];
    chats: unknown[];
    removedProjectIds?: Set<string>;
  }) => {
    const state = get();
    const decoded = decodePersistedState({
      activeProjectId: state.activeProjectId,
      chats,
      closedProjects,
      messagesByChatId: state.messagesByChatId,
      projects,
      settings: state.settings,
    });

    const liveChatIds = new Set(decoded.chats.map((chat) => chat.id));
    const messagesByChatId = Object.fromEntries(
      Object.entries(state.messagesByChatId).filter(([chatId]) =>
        liveChatIds.has(chatId),
      ),
    );
    const draftChatIdByProject = Object.fromEntries(
      Object.entries(state.draftChatIdByProject).filter(
        ([projectId, chatId]) =>
          !removedProjectIds.has(projectId) &&
          (chatId === null || liveChatIds.has(chatId)),
      ),
    );

    set({
      activeProjectId: ensureActiveProject(
        decoded.projects,
        state.activeProjectId,
      ),
      chats: decoded.chats,
      closedProjects: decoded.closedProjects,
      draftChatIdByProject,
      messagesByChatId,
      projects: decoded.projects,
    });
  };

  const applyCatalogChanges: IdeState["applyCatalogChanges"] = (
    changes,
    hostId = LOCAL_HOST_ID,
  ) => {
    const state = get();
    if (!state.stateHydrated) return;

    // A host's changes only ever remove that host's projects, and chats of
    // them: another host's project with an id it does not know is not gone.
    const hostProjectIds = new Set(
      [...state.projects, ...state.closedProjects]
        .filter((project) => getProjectHostId(project) === hostId)
        .map((project) => project.id),
    );
    const removedProjectIds = new Set(
      (changes.removedProjectIds ?? []).filter((id) => hostProjectIds.has(id)),
    );
    const removedChatIds = new Set(
      (changes.removedChatIds ?? []).filter((id) => {
        const chat = state.chats.find((item) => item.id === id);
        return !chat || hostProjectIds.has(chat.projectId);
      }),
    );
    const incomingProjects = new Map(
      (changes.projects ?? [])
        .filter(isRecordWithId)
        .map((project) => [project.id, withHost(project, hostId)]),
    );
    const incomingChats = new Map(
      (changes.chats ?? [])
        .filter(isRecordWithId)
        .map((chat) => [chat.id, chat]),
    );

    // Catalog fields from the host; this window's workspace fields kept.
    const mergeProject = (project: ProjectConfig): unknown => {
      const incoming = incomingProjects.get(project.id);
      return incoming
        ? {
            ...incoming,
            id: project.id,
            lastUsedAt: project.lastUsedAt,
            ui: project.ui,
          }
        : project;
    };
    const keepProject = (project: ProjectConfig) =>
      !removedProjectIds.has(project.id);
    const knownProjectIds = new Set(
      [...state.projects, ...state.closedProjects].map((project) => project.id),
    );

    const projects = state.projects.filter(keepProject).map(mergeProject);
    const closedProjects = [
      ...state.closedProjects.filter(keepProject).map(mergeProject),
      ...[...incomingProjects.values()].filter(
        (project) => !knownProjectIds.has(project.id as string),
      ),
    ];

    const knownChatIds = new Set(state.chats.map((chat) => chat.id));
    const chats = [
      ...state.chats
        .filter(
          (chat) =>
            !removedChatIds.has(chat.id) &&
            !removedProjectIds.has(chat.projectId),
        )
        .map((chat): unknown => {
          const incoming = incomingChats.get(chat.id);
          return incoming
            ? { ...incoming, messageCount: chat.messageCount }
            : chat;
        }),
      ...[...incomingChats.values()].filter(
        (chat) => !knownChatIds.has(chat.id),
      ),
    ];

    applyDecoded({ chats, closedProjects, projects, removedProjectIds });

    // The host has these now; they are not this window's to send back.
    const after = get();
    const isIncoming = (item: { id: string }) =>
      incomingProjects.has(item.id) || incomingChats.has(item.id);
    const sync = getCatalogSync(hostId);
    sync.remember({
      chats: after.chats.filter(isIncoming) as ChatConfig[],
      closedProjects: after.closedProjects.filter(isIncoming),
      projects: after.projects.filter(isIncoming),
    });
    sync.forget({
      chatIds: [...removedChatIds],
      projectIds: [...removedProjectIds],
    });
  };

  /** Replaces the running turns this host reports. */
  const setRunning = (hostId: string, chatIds: string[]) => {
    const state = get();
    const projectsById = new Map(
      [...state.projects, ...state.closedProjects].map((project) => [
        project.id,
        project,
      ]),
    );
    const hostOfChat = (chatId: string) => {
      const chat = state.chats.find((item) => item.id === chatId);
      const project = chat ? projectsById.get(chat.projectId) : undefined;
      return project ? getProjectHostId(project) : LOCAL_HOST_ID;
    };
    const next: Record<string, true> = {};
    for (const chatId of Object.keys(state.hostRunningChatIds)) {
      if (hostOfChat(chatId) !== hostId) next[chatId] = true;
    }
    for (const chatId of chatIds) next[chatId] = true;
    set({ hostRunningChatIds: next });
  };

  return {
    applyCatalogChanges,

    adoptHostProjects: async (hostId, conflicts) => {
      // The host's own projects, read from it: the store cannot hold the
      // one it kept beside the refused one (one project per path).
      let catalog: Awaited<ReturnType<typeof loadCatalog>>;
      try {
        catalog = await loadCatalog(hostId);
      } catch (error) {
        console.warn(`Unable to read the catalog of host ${hostId}.`, error);
        return;
      }
      const hostProjects = new Map(
        catalog.projects
          .filter(isRecordWithId)
          .map((project) => [project.id, project]),
      );

      for (const { id, existingId } of conflicts) {
        const keptRow = hostProjects.get(existingId);
        if (!keptRow || existingId === id) continue;
        set((state) => {
          const all = [...state.projects, ...state.closedProjects];
          const refused = all.find((project) => project.id === id);
          if (!refused) return {};

          // The host's project takes the refused one's place: open or
          // closed, its position, and what this window had open in it.
          const adopted = {
            ...refused,
            ...withHost(keptRow, hostId),
            id: existingId,
            lastUsedAt: refused.lastUsedAt,
            ui: refused.ui,
          } as ProjectConfig;
          const kept = { id: existingId };
          const swap = (projects: ProjectConfig[]) =>
            projects.flatMap((project) =>
              project.id === refused.id
                ? [adopted]
                : project.id === kept.id
                  ? []
                  : [project],
            );
          const projects = swap(state.projects);
          const closedProjects = swap(state.closedProjects);

          const { [refused.id]: draftChatId = null, ...draftChatIdByProject } =
            state.draftChatIdByProject;
          return {
            activeProjectId:
              state.activeProjectId === refused.id
                ? kept.id
                : state.activeProjectId,
            // Its chats go with it: the host refused them along with it.
            chats: state.chats.map((chat) =>
              chat.projectId === refused.id
                ? { ...chat, projectId: kept.id }
                : chat,
            ),
            closedProjects,
            draftChatIdByProject: {
              ...draftChatIdByProject,
              ...(draftChatId ? { [kept.id]: draftChatId } : {}),
            },
            projects,
          };
        });
      }
      get().persist();
      // Its chats, and anything else the host has that this window lacks.
      await get().reloadCatalog(hostId);
    },

    setHostTurnRunning: (chatId, running) => {
      const current = get().hostRunningChatIds;
      if (Boolean(current[chatId]) === running) return;
      const next = { ...current };
      if (running) next[chatId] = true;
      else delete next[chatId];
      set({ hostRunningChatIds: next });
    },

    applyCatalogTranscript: async (chatId) => {
      const state = get();
      // Not loaded here: it loads fresh when a panel opens it.
      if (!Object.hasOwn(state.messagesByChatId, chatId)) return;
      // A turn this window is streaming owns its transcript.
      if (state.streamingChatIds[chatId]) return;
      try {
        const messages = await loadPersistedChatMessages(chatId);
        if (
          get().streamingChatIds[chatId] ||
          !get().chats.some((chat) => chat.id === chatId)
        ) {
          return;
        }
        get().setMessagesForChat(chatId, messages);
      } catch {
        // The next change or a reopen loads it again.
      }
    },

    loadHostCatalog: async (hostId) => {
      const catalog = await loadCatalog(hostId);
      const state = get();
      // This window's workspace rows for the host, as last saved, decide
      // which of its projects are open; the host decides what exists.
      const merged = mergeWorkspaceAndCatalog({
        catalog,
        hostId,
        workspace: {
          workspaceProjects: getLoadedWorkspace().workspaceProjects,
        },
      }) as {
        projects: unknown[];
        closedProjects: unknown[];
        chats: unknown[];
      };
      const onOtherHosts = (project: ProjectConfig) =>
        getProjectHostId(project) !== hostId;
      const otherProjectIds = new Set(
        [...state.projects, ...state.closedProjects]
          .filter(onOtherHosts)
          .map((project) => project.id),
      );

      // Projects already showing from the snapshot keep where they are
      // (open or closed, and their place): the tabs may have been moved
      // while the host was away. New ones go after them.
      const idOf = (project: unknown) => (project as { id: string }).id;
      const openIds = new Set(state.projects.map((project) => project.id));
      const closedIds = new Set(
        state.closedProjects.map((project) => project.id),
      );
      const hostProjects = [...merged.projects, ...merged.closedProjects];
      const mergedOpenIds = new Set(merged.projects.map(idOf));
      const isOpen = (project: unknown) =>
        openIds.has(idOf(project)) ||
        (!closedIds.has(idOf(project)) && mergedOpenIds.has(idOf(project)));
      const inPlace = (list: unknown[], previous: ProjectConfig[]) => {
        const index = new Map(
          previous.map((project, position) => [project.id, position]),
        );
        const at = (project: unknown) =>
          index.get(idOf(project)) ?? Number.POSITIVE_INFINITY;
        return list
          .map((project, position) => ({ position, project }))
          .sort(
            (a, b) => at(a.project) - at(b.project) || a.position - b.position,
          )
          .map((item) => item.project);
      };

      applyDecoded({
        chats: [
          ...state.chats.filter((chat) => otherProjectIds.has(chat.projectId)),
          ...merged.chats,
        ],
        closedProjects: inPlace(
          [
            ...state.closedProjects.filter(onOtherHosts),
            ...hostProjects.filter((project) => !isOpen(project)),
          ],
          state.closedProjects,
        ),
        projects: inPlace(
          [
            ...state.projects.filter(onOtherHosts),
            ...hostProjects.filter(isOpen),
          ],
          state.projects,
        ),
      });

      const after = get();
      const onHost = (project: ProjectConfig) =>
        getProjectHostId(project) === hostId;
      const hostProjectIds = new Set(
        [...after.projects, ...after.closedProjects]
          .filter(onHost)
          .map((project) => project.id),
      );
      getCatalogSync(hostId).reset({
        chats: after.chats.filter((chat) => hostProjectIds.has(chat.projectId)),
        closedProjects: after.closedProjects.filter(onHost),
        projects: after.projects.filter(onHost),
      });
      markHostLoaded(hostId);
      setRunning(hostId, catalog.runningChatIds ?? []);
    },

    reloadCatalog: async (hostId = LOCAL_HOST_ID) => {
      if (!get().stateHydrated) return;
      let catalog: Awaited<ReturnType<typeof loadCatalog>>;
      try {
        catalog = await loadCatalog(hostId);
      } catch (error) {
        console.warn(`Unable to reload the catalog of host ${hostId}.`, error);
        return;
      }
      setRunning(hostId, catalog.runningChatIds ?? []);
      const state = get();
      const sync = getCatalogSync(hostId);
      const catalogProjectIds = new Set(
        catalog.projects.filter(isRecordWithId).map((project) => project.id),
      );
      const catalogChatIds = new Set(
        catalog.chats.filter(isRecordWithId).map((chat) => chat.id),
      );
      // Only what the host had confirmed and no longer has is gone; a
      // change this window has not sent yet is not.
      applyCatalogChanges(
        {
          chats: catalog.chats,
          projects: catalog.projects,
          removedChatIds: state.chats
            .map((chat) => chat.id)
            .filter(
              (id) => !catalogChatIds.has(id) && sync.isSynced("chat", id),
            ),
          removedProjectIds: [...state.projects, ...state.closedProjects]
            .map((project) => project.id)
            .filter(
              (id) =>
                !catalogProjectIds.has(id) && sync.isSynced("project", id),
            ),
        },
        hostId,
      );
    },
  };
};
