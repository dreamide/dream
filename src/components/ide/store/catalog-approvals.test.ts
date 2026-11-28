// A chat the host says waits on a tool approval, whether or not a session
// in this window follows its turn.
import { expect, test } from "vitest";
import { createStore } from "zustand/vanilla";
import { chatTurnOutcomes } from "../chat-turn-outcome";
import { createCatalogActions } from "./catalog-actions";
import type { IdeState } from "./ide-store-types";

const createTestStore = () => {
  const store = createStore<IdeState>()(
    () =>
      ({
        chats: [],
        closedProjects: [],
        hostAwaitingApprovalChatIds: {},
        hostRunningChatIds: {},
        projects: [],
      }) as unknown as IdeState,
  );
  const catalog = createCatalogActions(store.setState, store.getState, {
    persist: () => {},
  });
  store.setState(catalog.actions);
  return { catalog, store };
};

test("a host's approval events mark and clear a chat", () => {
  const { catalog, store } = createTestStore();
  catalog.setHostTurnRunning("local", "c1", true);
  catalog.setHostChatAwaitingApproval("local", "c1", true);
  expect(store.getState().hostAwaitingApprovalChatIds).toEqual({ c1: "local" });

  const before = store.getState().hostAwaitingApprovalChatIds;
  catalog.setHostChatAwaitingApproval("local", "c1", true);
  expect(store.getState().hostAwaitingApprovalChatIds).toBe(before);

  catalog.setHostChatAwaitingApproval("local", "c1", false);
  expect(store.getState().hostAwaitingApprovalChatIds).toEqual({});
});

test("a turn that ends waits on nothing", () => {
  const { catalog, store } = createTestStore();
  catalog.setHostTurnRunning("local", "c1", true);
  catalog.setHostChatAwaitingApproval("local", "c1", true);
  catalog.setHostTurnRunning("local", "c1", false);
  expect(store.getState().hostAwaitingApprovalChatIds).toEqual({});
  expect(store.getState().hostRunningChatIds).toEqual({});
});

test("only the reporting Host can settle its turn outcome", () => {
  const { catalog, store } = createTestStore();
  const stop = chatTurnOutcomes.watch(store);
  try {
    catalog.setHostTurnRunning("first", "turn", true);
    catalog.setHostTurnRunning("second", "turn", false, { status: "finished" });
    expect(chatTurnOutcomes.store.getState().turns.turn?.status).toBe(
      "running",
    );
    catalog.setHostTurnRunning("first", "turn", false, {
      status: "failed",
      detail: "Provider disconnected",
    });
    expect(chatTurnOutcomes.store.getState().turns.turn).toMatchObject({
      status: "failed",
      detail: "Provider disconnected",
    });
  } finally {
    stop();
  }
});
