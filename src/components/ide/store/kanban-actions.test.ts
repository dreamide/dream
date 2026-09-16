import assert from "node:assert/strict";
import { test } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  createKanbanCard,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { KanbanCard, KanbanColumnId } from "@/types/ide";
import { useActivityStore } from "../activity-store";
import { createChatActions } from "./chat-actions";
import type { IdeState } from "./ide-store-types";
import {
  advanceKanbanCardsInProjects,
  createKanbanActions,
  moveKanbanCardInList,
} from "./kanban-actions";
import { createPanelActions } from "./panel-actions";
import { createRuntimeActions } from "./runtime-actions";

const createTestStore = () => {
  const project = createProjectConfig("/workspace/source", DEFAULT_SETTINGS);
  const store = createStore<IdeState>(
    () =>
      ({
        activeProjectId: project.id,
        awaitingAnswerChatIds: {},
        chats: [],
        chatSort: "recent",
        closedProjects: [],
        completedChatIds: {},
        draftChatIdByProject: {},
        messagesByChatId: {},
        pendingChatSubmitByChatId: {},
        projects: [project],
        settings: DEFAULT_SETTINGS,
        streamingChatIds: {},
        titleGeneratingChatIds: {},
      }) as unknown as IdeState,
  );
  store.setState({
    ...createChatActions(store.setState, store.getState),
    ...createPanelActions(store.setState),
    ...createRuntimeActions(store.setState),
    ...createKanbanActions(store.setState, store.getState),
  });

  return { project, store };
};

const card = (
  id: string,
  column: KanbanColumnId,
  chatId: string | null = null,
): KanbanCard => ({
  ...createKanbanCard({ chatId, column, title: id }),
  id,
});

const columnOrder = (cards: KanbanCard[], column: KanbanColumnId) =>
  cards.filter((entry) => entry.column === column).map((entry) => entry.id);

const getCards = (store: ReturnType<typeof createTestStore>["store"]) =>
  store.getState().projects[0]?.ui.kanbanCards ?? [];

test("adds, updates, and deletes kanban cards", () => {
  const { project, store } = createTestStore();

  assert.equal(
    store.getState().addKanbanCard(project.id, { title: "   " }),
    null,
  );

  const cardId = store.getState().addKanbanCard(project.id, {
    description: "  Details  ",
    title: "  Ship it  ",
  });
  assert.ok(cardId);

  const created = getCards(store)[0];
  assert.equal(created?.title, "Ship it");
  assert.equal(created?.description, "Details");
  assert.equal(created?.column, "backlog");
  assert.equal(created?.chatId, null);

  store.getState().updateKanbanCard(project.id, cardId, (current) => ({
    ...current,
    createdAt: "tampered",
    id: "tampered",
    title: "Renamed",
  }));
  const updated = getCards(store)[0];
  assert.equal(updated?.id, cardId);
  assert.equal(updated?.createdAt, created?.createdAt);
  assert.equal(updated?.title, "Renamed");

  store.getState().deleteKanbanCard(project.id, cardId);
  assert.equal(getCards(store).length, 0);
});

test("moveKanbanCardInList keeps per-column order stable", () => {
  const cards = [
    card("A", "backlog"),
    card("B", "backlog"),
    card("C", "review"),
    card("D", "backlog"),
  ];

  const movedToTop = moveKanbanCardInList(cards, "D", "backlog", 0);
  assert.deepEqual(columnOrder(movedToTop, "backlog"), ["D", "A", "B"]);
  assert.deepEqual(columnOrder(movedToTop, "review"), ["C"]);

  const movedAcross = moveKanbanCardInList(cards, "A", "review", 1);
  assert.deepEqual(columnOrder(movedAcross, "review"), ["C", "A"]);
  assert.deepEqual(columnOrder(movedAcross, "backlog"), ["B", "D"]);
  assert.equal(movedAcross.find((entry) => entry.id === "A")?.column, "review");

  const clamped = moveKanbanCardInList(cards, "A", "backlog", 99);
  assert.deepEqual(columnOrder(clamped, "backlog"), ["B", "D", "A"]);

  const intoEmpty = moveKanbanCardInList(cards, "C", "done", 0);
  assert.deepEqual(columnOrder(intoEmpty, "done"), ["C"]);

  assert.equal(moveKanbanCardInList(cards, "A", "backlog", 0), cards);
  assert.equal(moveKanbanCardInList(cards, "missing", "backlog", 0), cards);
});

test("startKanbanCard creates a chat seeded with the task and links the card", () => {
  const { project, store } = createTestStore();
  const cardId = store.getState().addKanbanCard(project.id, {
    description: "Do the thing",
    title: "Task",
  });
  assert.ok(cardId);

  const chatId = store.getState().startKanbanCard(project.id, cardId);
  assert.ok(chatId);

  const state = store.getState();
  const chat = state.chats.find((entry) => entry.id === chatId);
  assert.equal(chat?.title, "Task");
  assert.deepEqual(state.pendingChatSubmitByChatId[chatId], {
    references: [],
    text: "Task\n\nDo the thing",
  });
  assert.equal(state.projects[0]?.ui.activeChatId, chatId);

  const linked = getCards(store)[0];
  assert.equal(linked?.chatId, chatId);
  assert.equal(linked?.column, "inProgress");

  assert.equal(store.getState().startKanbanCard(project.id, cardId), chatId);
  assert.equal(store.getState().chats.length, 1);
});

test("startKanbanCard leaves a non-backlog card in its column", () => {
  const { project, store } = createTestStore();
  const cardId = store.getState().addKanbanCard(project.id, {
    column: "review",
    title: "Follow-up",
  });
  assert.ok(cardId);

  const chatId = store.getState().startKanbanCard(project.id, cardId);
  assert.ok(chatId);
  assert.equal(getCards(store)[0]?.column, "review");
  assert.equal(
    store.getState().pendingChatSubmitByChatId[chatId]?.text,
    "Follow-up",
  );
});

test("openKanbanCardChat activates the chat in the code workspace", () => {
  const { project, store } = createTestStore();
  const cardId = store.getState().addKanbanCard(project.id, { title: "Task" });
  assert.ok(cardId);
  const chatId = store.getState().startKanbanCard(project.id, cardId);
  assert.ok(chatId);

  store.getState().setProjectWorkspaceView(project.id, "kanban");
  store.getState().addChat(project.id, undefined, { forceNew: true });
  assert.notEqual(store.getState().projects[0]?.ui.activeChatId, chatId);

  store.getState().openKanbanCardChat(project.id, cardId);
  assert.equal(store.getState().projects[0]?.ui.activeChatId, chatId);
  assert.equal(store.getState().projects[0]?.ui.workspaceView, "code");
});

test("deleting a linked chat unlinks the card", () => {
  const { project, store } = createTestStore();
  const cardId = store.getState().addKanbanCard(project.id, { title: "Task" });
  assert.ok(cardId);
  const chatId = store.getState().startKanbanCard(project.id, cardId);
  assert.ok(chatId);

  store.getState().deleteChat(chatId);
  assert.equal(getCards(store)[0]?.chatId, null);
  assert.equal(getCards(store)[0]?.column, "inProgress");
});

test("a finished stream advances the linked card from in progress to review", () => {
  const { project, store } = createTestStore();
  const cardId = store.getState().addKanbanCard(project.id, { title: "Task" });
  assert.ok(cardId);
  const chatId = store.getState().startKanbanCard(project.id, cardId);
  assert.ok(chatId);

  store.getState().setChatStreaming(chatId, true);
  useActivityStore.getState().finish(chatId, "finished", "");
  store.getState().setChatStreaming(chatId, false);
  assert.equal(getCards(store)[0]?.column, "review");
});

test("a stream that stops waiting for an answer keeps the card in progress", () => {
  const { project, store } = createTestStore();
  const cardId = store.getState().addKanbanCard(project.id, { title: "Task" });
  assert.ok(cardId);
  const chatId = store.getState().startKanbanCard(project.id, cardId);
  assert.ok(chatId);

  store.getState().setChatStreaming(chatId, true);
  useActivityStore.getState().attention(chatId, "Which option?");
  store.getState().setChatStreaming(chatId, false);
  assert.equal(getCards(store)[0]?.column, "inProgress");
});

test("advanceKanbanCardsInProjects returns the same reference when nothing changes", () => {
  const { project } = createTestStore();
  const projects = [project];
  assert.equal(advanceKanbanCardsInProjects(projects, "unknown"), projects);
});
