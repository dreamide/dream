// A chat the host says waits on a tool approval, whether or not a session
// in this window follows its turn.
import { expect, test } from "vitest";
import { createStore } from "zustand/vanilla";
import { createCatalogActions } from "./catalog-actions";
import type { IdeState } from "./ide-store-types";

const createTestStore = () =>
  createStore<IdeState>()(
    (set, get) =>
      ({
        chats: [],
        closedProjects: [],
        hostAwaitingApprovalChatIds: {},
        hostRunningChatIds: {},
        projects: [],
        ...createCatalogActions(set, get),
      }) as unknown as IdeState,
  );

test("a host's approval events mark and clear a chat", () => {
  const store = createTestStore();
  store.getState().setHostTurnRunning("c1", true);
  store.getState().setHostChatAwaitingApproval("c1", true);
  expect(store.getState().hostAwaitingApprovalChatIds).toEqual({ c1: true });

  const before = store.getState().hostAwaitingApprovalChatIds;
  store.getState().setHostChatAwaitingApproval("c1", true);
  expect(store.getState().hostAwaitingApprovalChatIds).toBe(before);

  store.getState().setHostChatAwaitingApproval("c1", false);
  expect(store.getState().hostAwaitingApprovalChatIds).toEqual({});
});

test("a turn that ends waits on nothing", () => {
  const store = createTestStore();
  store.getState().setHostTurnRunning("c1", true);
  store.getState().setHostChatAwaitingApproval("c1", true);
  store.getState().setHostTurnRunning("c1", false);
  expect(store.getState().hostAwaitingApprovalChatIds).toEqual({});
  expect(store.getState().hostRunningChatIds).toEqual({});
});
