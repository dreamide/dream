import { createKanbanCard } from "@/lib/ide-defaults";
import type { KanbanCard, KanbanColumnId, ProjectConfig } from "@/types/ide";
import { updateProjectUiInList } from ".";
import type { IdeState, IdeStoreGet, IdeStoreSet } from "./ide-store-types";

const getProjectKanbanCards = (
  project: { ui: { kanbanCards?: KanbanCard[] } } | undefined,
) => project?.ui.kanbanCards ?? [];

/**
 * Moves a card to `column` at `index` (position among that column's other
 * cards). The global array order is preserved for every other card so that
 * each column's filtered order stays stable. Returns the same reference when
 * nothing changes.
 */
export const moveKanbanCardInList = (
  cards: KanbanCard[],
  cardId: string,
  column: KanbanColumnId,
  index: number,
): KanbanCard[] => {
  const cardIndex = cards.findIndex((card) => card.id === cardId);
  if (cardIndex === -1) {
    return cards;
  }

  const card = cards[cardIndex];
  const rest = cards.filter((entry) => entry.id !== cardId);
  const targets = rest.filter((entry) => entry.column === column);
  const requestedIndex = Number.isFinite(index)
    ? Math.trunc(index)
    : targets.length;
  const clampedIndex = Math.max(0, Math.min(requestedIndex, targets.length));
  const lastTarget = targets[targets.length - 1];
  const insertAt =
    clampedIndex < targets.length
      ? rest.indexOf(targets[clampedIndex])
      : lastTarget
        ? rest.indexOf(lastTarget) + 1
        : rest.length;

  if (card.column === column && insertAt === cardIndex) {
    return cards;
  }

  const moved =
    card.column === column
      ? card
      : { ...card, column, updatedAt: new Date().toISOString() };
  const next = [...rest];
  next.splice(insertAt, 0, moved);
  return next;
};

/**
 * Moves every card linked to `chatId` from "In progress" to the end of
 * "Review". Returns the same reference when nothing changes.
 */
export const advanceKanbanCardsInProjects = (
  projects: ProjectConfig[],
  chatId: string,
): ProjectConfig[] => {
  let changed = false;
  const next = projects.map((project) => {
    const cards = getProjectKanbanCards(project);
    const card = cards.find(
      (entry) => entry.chatId === chatId && entry.column === "inProgress",
    );
    if (!card) {
      return project;
    }

    changed = true;
    return {
      ...project,
      ui: {
        ...project.ui,
        kanbanCards: moveKanbanCardInList(
          cards,
          card.id,
          "review",
          Number.POSITIVE_INFINITY,
        ),
      },
    };
  });

  return changed ? next : projects;
};

const unlinkKanbanCardsInProjects = (
  projects: ProjectConfig[],
  chatIds: Set<string>,
  timestamp: string,
): ProjectConfig[] => {
  let changed = false;
  const next = projects.map((project) => {
    const cards = getProjectKanbanCards(project);
    if (
      !cards.some((card) => card.chatId !== null && chatIds.has(card.chatId))
    ) {
      return project;
    }

    changed = true;
    return {
      ...project,
      ui: {
        ...project.ui,
        kanbanCards: cards.map((card) =>
          card.chatId !== null && chatIds.has(card.chatId)
            ? { ...card, chatId: null, updatedAt: timestamp }
            : card,
        ),
      },
    };
  });

  return changed ? next : projects;
};

export const createKanbanActions = (
  set: IdeStoreSet,
  get: IdeStoreGet,
): Pick<
  IdeState,
  | "addKanbanCard"
  | "updateKanbanCard"
  | "deleteKanbanCard"
  | "moveKanbanCard"
  | "startKanbanCard"
  | "openKanbanCardChat"
  | "unlinkKanbanCardsForChats"
  | "advanceKanbanCardsForChat"
> => ({
  addKanbanCard: (projectId, card) => {
    const state = get();
    const project = state.projects.find((entry) => entry.id === projectId);
    if (!project) {
      return null;
    }

    const title = card.title.trim();
    if (!title) {
      return null;
    }

    const nextCard = createKanbanCard({
      column: card.column,
      description: card.description?.trim() ?? "",
      title,
    });

    set({
      projects: updateProjectUiInList(state.projects, projectId, (entry) => ({
        ...entry.ui,
        kanbanCards: [...getProjectKanbanCards(entry), nextCard],
      })),
    });

    return nextCard.id;
  },

  updateKanbanCard: (projectId, cardId, updater) => {
    set((state) => {
      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) {
        return state;
      }

      const currentCard = getProjectKanbanCards(project).find(
        (card) => card.id === cardId,
      );
      if (!currentCard) {
        return state;
      }

      const nextCard: KanbanCard = {
        ...updater(currentCard),
        id: currentCard.id,
        createdAt: currentCard.createdAt,
        updatedAt: new Date().toISOString(),
      };

      return {
        projects: updateProjectUiInList(state.projects, projectId, (entry) => ({
          ...entry.ui,
          kanbanCards: getProjectKanbanCards(entry).map((card) =>
            card.id === cardId ? nextCard : card,
          ),
        })),
      };
    });
  },

  deleteKanbanCard: (projectId, cardId) => {
    set((state) => {
      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) {
        return state;
      }

      if (!getProjectKanbanCards(project).some((card) => card.id === cardId)) {
        return state;
      }

      return {
        projects: updateProjectUiInList(state.projects, projectId, (entry) => ({
          ...entry.ui,
          kanbanCards: getProjectKanbanCards(entry).filter(
            (card) => card.id !== cardId,
          ),
        })),
      };
    });
  },

  moveKanbanCard: (projectId, cardId, column, index) => {
    set((state) => {
      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) {
        return state;
      }

      const cards = getProjectKanbanCards(project);
      const nextCards = moveKanbanCardInList(cards, cardId, column, index);
      if (nextCards === cards) {
        return state;
      }

      return {
        projects: updateProjectUiInList(state.projects, projectId, (entry) => ({
          ...entry.ui,
          kanbanCards: nextCards,
        })),
      };
    });
  },

  startKanbanCard: (projectId, cardId) => {
    const state = get();
    const project = state.projects.find((entry) => entry.id === projectId);
    const card = getProjectKanbanCards(project).find(
      (entry) => entry.id === cardId,
    );
    if (!project || !card) {
      return null;
    }

    // Idempotent: a card whose chat is still alive keeps that chat.
    if (
      card.chatId &&
      state.chats.some(
        (chat) => chat.id === card.chatId && chat.deletedAt === null,
      )
    ) {
      return card.chatId;
    }

    const title = card.title.trim();
    if (!title) {
      return null;
    }

    const chatId = project.ui.multiChat
      ? get().addChatBeside(projectId)
      : get().addChat(projectId, title, { forceNew: true });
    if (!chatId) {
      return null;
    }

    // `addChat` already applies the default model selection; only the title
    // and any stale remote-conversation linkage need adjusting here.
    get().updateChat(chatId, (chat) => ({
      ...chat,
      remoteConversationId: null,
      remoteConversationModel: null,
      remoteConversationModelSpeed: null,
      remoteConversationProjectPath: null,
      title,
    }));

    const description = card.description.trim();
    const text = description ? `${title}\n\n${description}` : title;
    const timestamp = new Date().toISOString();

    set((current) => {
      const currentProject = current.projects.find(
        (entry) => entry.id === projectId,
      );
      const linkedCards = getProjectKanbanCards(currentProject).map((entry) =>
        entry.id === cardId
          ? { ...entry, chatId, updatedAt: timestamp }
          : entry,
      );
      const nextCards =
        card.column === "backlog" || card.column === "ready"
          ? moveKanbanCardInList(
              linkedCards,
              cardId,
              "inProgress",
              Number.POSITIVE_INFINITY,
            )
          : linkedCards;

      return {
        pendingChatSubmitByChatId: {
          ...current.pendingChatSubmitByChatId,
          [chatId]: { references: [], text },
        },
        projects: updateProjectUiInList(
          current.projects,
          projectId,
          (entry) => ({
            ...entry.ui,
            kanbanCards: nextCards,
          }),
        ),
      };
    });

    return chatId;
  },

  openKanbanCardChat: (projectId, cardId) => {
    const state = get();
    const project = state.projects.find((entry) => entry.id === projectId);
    const card = getProjectKanbanCards(project).find(
      (entry) => entry.id === cardId,
    );
    if (!card?.chatId) {
      return;
    }

    const chat = state.chats.find(
      (entry) => entry.id === card.chatId && entry.deletedAt === null,
    );
    if (!chat) {
      return;
    }

    get().setActiveChatId(projectId, chat.id);
    get().setProjectWorkspaceView(projectId, "code");
  },

  unlinkKanbanCardsForChats: (chatIds) => {
    const ids = new Set(chatIds);
    if (ids.size === 0) {
      return;
    }

    set((state) => {
      const timestamp = new Date().toISOString();
      const projects = unlinkKanbanCardsInProjects(
        state.projects,
        ids,
        timestamp,
      );
      const closedProjects = unlinkKanbanCardsInProjects(
        state.closedProjects,
        ids,
        timestamp,
      );
      if (
        projects === state.projects &&
        closedProjects === state.closedProjects
      ) {
        return state;
      }

      return { closedProjects, projects };
    });
  },

  advanceKanbanCardsForChat: (chatId) => {
    set((state) => {
      const projects = advanceKanbanCardsInProjects(state.projects, chatId);
      return projects === state.projects ? state : { projects };
    });
  },
});
