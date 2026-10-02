/**
 * Keeps the store and the local host's catalog in step.
 *
 * The store holds projects, chats and loaded transcripts as before; the host
 * owns them. On every save the store's state is compared with what the host
 * last confirmed (the baseline) and only the difference is sent, as one
 * change set. Upserts come from the encoded state (what deserves saving);
 * removals are only ids this client synced before that have since left the
 * live store, so a draft another client created, which this client's
 * encoder drops, is never deleted by it. Change sets and transcript saves
 * share one queue, so a chat reaches the host before its transcript.
 *
 * Changes made elsewhere arrive as catalog events and are applied to the
 * store by the caller; `remember` records them in the baseline so they are
 * not sent back.
 */
import type { UIMessage } from "ai";
import type { ApiClient, CatalogChangesResponse } from "@/lib/api-client";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import {
  chatToRow,
  projectToCatalogRow,
} from "../../../../electron/shared/persisted-state-codec.js";

type CatalogRoutes = Pick<
  ApiClient,
  "catalogChanges" | "saveCatalogTranscript"
>;

export interface CatalogState {
  projects: ProjectConfig[];
  closedProjects: ProjectConfig[];
  chats: ChatConfig[];
}

export interface CatalogChangeSet {
  projects: ProjectConfig[];
  removedProjectIds: string[];
  chats: ChatConfig[];
  removedChatIds: string[];
}

const projectKey = (project: ProjectConfig) =>
  JSON.stringify(projectToCatalogRow(project));

const chatKey = (chat: ChatConfig) => {
  // The live message count changes with every saved message and is the
  // host's to compute; it does not make a chat worth re-sending.
  const { metadata, ...row } = chatToRow(chat);
  const { messageCount: _count, ...rest } = metadata as Record<string, unknown>;
  return JSON.stringify({ ...row, metadata: rest });
};

const isEmpty = (changes: CatalogChangeSet) =>
  changes.projects.length === 0 &&
  changes.chats.length === 0 &&
  changes.removedProjectIds.length === 0 &&
  changes.removedChatIds.length === 0;

export type CatalogConflict = CatalogChangesResponse["conflicts"][number];

export const createCatalogSync = ({
  api,
  onConflicts,
}: {
  api: CatalogRoutes;
  /**
   * Projects the host refused because another of its projects already has
   * that path. Sending them again would be refused again; the caller
   * switches to the host's project instead.
   */
  onConflicts?: (conflicts: CatalogConflict[]) => void;
}) => {
  const syncedProjects = new Map<string, string>();
  const syncedChats = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  /** Records what the host now has, so it is not sent again. */
  const remember = (state: Partial<CatalogState>) => {
    for (const project of [
      ...(state.projects ?? []),
      ...(state.closedProjects ?? []),
    ]) {
      syncedProjects.set(project.id, projectKey(project));
    }
    for (const chat of state.chats ?? []) {
      syncedChats.set(chat.id, chatKey(chat));
    }
  };

  const forget = ({
    projectIds = [],
    chatIds = [],
  }: {
    projectIds?: string[];
    chatIds?: string[];
  }) => {
    for (const id of projectIds) syncedProjects.delete(id);
    for (const id of chatIds) syncedChats.delete(id);
  };

  /** The change set that brings the host to `encoded`. */
  const diff = (
    live: CatalogState,
    encoded: CatalogState,
  ): CatalogChangeSet => {
    const projects = [...encoded.projects, ...encoded.closedProjects].filter(
      (project) => syncedProjects.get(project.id) !== projectKey(project),
    );
    const chats = encoded.chats.filter(
      (chat) => syncedChats.get(chat.id) !== chatKey(chat),
    );
    const liveProjectIds = new Set(
      [...live.projects, ...live.closedProjects].map((project) => project.id),
    );
    const liveChatIds = new Set(live.chats.map((chat) => chat.id));
    return {
      chats,
      projects,
      removedChatIds: [...syncedChats.keys()].filter(
        (id) => !liveChatIds.has(id),
      ),
      removedProjectIds: [...syncedProjects.keys()].filter(
        (id) => !liveProjectIds.has(id),
      ),
    };
  };

  return {
    /** Starts over from a freshly loaded catalog. */
    reset(state: CatalogState) {
      syncedProjects.clear();
      syncedChats.clear();
      remember(state);
    },

    remember,
    forget,

    /** Ids the host has confirmed (the only ones a refetch may remove). */
    isSynced: (kind: "project" | "chat", id: string) =>
      (kind === "project" ? syncedProjects : syncedChats).has(id),

    /**
     * Sends what changed since the last confirmed state. The baseline moves
     * now, so the next save does not resend it; a failed send forgets the
     * entries so they are sent again.
     */
    push(live: CatalogState, encoded: CatalogState) {
      const changes = diff(live, encoded);
      if (isEmpty(changes)) return Promise.resolve(null);

      remember({ chats: changes.chats, projects: changes.projects });
      forget({
        chatIds: changes.removedChatIds,
        projectIds: changes.removedProjectIds,
      });

      return enqueue(() => api.catalogChanges(changes))
        .then((result: CatalogChangesResponse) => {
          for (const conflict of result.conflicts) {
            syncedProjects.delete(conflict.id);
            console.warn(
              `Project ${conflict.id} was not saved: ${conflict.path} already belongs to project ${conflict.existingId}.`,
            );
          }
          if (result.conflicts.length > 0) onConflicts?.(result.conflicts);
          return result;
        })
        .catch((error: unknown) => {
          forget({
            chatIds: changes.chats.map((chat) => chat.id),
            projectIds: changes.projects.map((project) => project.id),
          });
          console.warn("Unable to save catalog changes.", error);
          return null;
        });
    },

    /** Replaces a chat's transcript on the host, after pending changes. */
    saveTranscript: (chatId: string, messages: UIMessage[]) =>
      enqueue(() => api.saveCatalogTranscript({ chatId, messages })),
  };
};

export type CatalogSync = ReturnType<typeof createCatalogSync>;
