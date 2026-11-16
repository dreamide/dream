import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  createFakeApiClient,
  type FakeApiHandlers,
  fakeApiError,
} from "@/lib/api-client-fake";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import { createChatActions } from "./chat-actions";
import type { IdeState } from "./ide-store-types";
import { createProjectLifecycleActions } from "./project-lifecycle-actions";
import { createStandaloneChatActions } from "./standalone-chat-actions";

const CHATS_ROOT = "/home/me/.dream/chats";

const createTestStore = (handlers: FakeApiHandlers = {}) => {
  const api = createFakeApiClient({
    createChatFolder: ({ projectId }) => ({
      path: `${CHATS_ROOT}/2026-11-16-${projectId.slice(0, 8)}`,
    }),
    ...handlers,
  });
  const plain = createProjectConfig("/workspace/app", DEFAULT_SETTINGS);
  const stopped: string[] = [];
  let persisted = 0;

  const store = createStore<IdeState>(
    () =>
      ({
        activeBrowserTabIdByProject: {},
        activeProjectId: null,
        activeTerminalSessionIdByProject: {},
        awaitingAnswerChatIds: {},
        browserLoading: {},
        browserTabsByProject: {},
        chats: [],
        chatSort: "recent",
        closedProjects: [],
        completedChatIds: {},
        draftChatIdByProject: {},
        gitWriteByProject: {},
        hosts: {},
        messagesByChatId: {},
        nextTerminalOrdinalByProject: {},
        pendingChatSubmitByChatId: {},
        projectFileSearchRequests: {},
        projectFilesRefreshKeys: {},
        projectGitPanelTabByProject: {},
        projectGitRefreshKeys: {},
        projects: [],
        projectTerminalSessionIds: {},
        settings: DEFAULT_SETTINGS,
        streamingChatIds: {},
        terminalSessionNames: {},
        terminalShell: {},
        terminalStatus: {},
        terminalTransport: {},
        titleGeneratingChatIds: {},
        transcriptPageByChatId: {},
      }) as unknown as IdeState,
  );
  store.setState({
    ...createProjectLifecycleActions(store.setState, store.getState),
    ...createChatActions(store.setState, store.getState, { api: api.client }),
    ...createStandaloneChatActions(store.setState, store.getState, {
      api: api.client,
    }),
    persist: () => {
      persisted += 1;
    },
    stopProjectTerminals: async (projectId: string) => {
      stopped.push(projectId);
    },
  });
  store.getState().addProject(plain.path);

  return {
    calls: api.calls,
    persisted: () => persisted,
    store,
    stopped,
  };
};

const created = async (store: ReturnType<typeof createTestStore>["store"]) => {
  const result = await store.getState().createStandaloneChat();
  assert.ok(result.ok, "created");
  return result;
};

const giveMessage = (
  store: ReturnType<typeof createTestStore>["store"],
  chatId: string,
) =>
  store
    .getState()
    .setMessagesForChat(chatId, [
      { id: "m1", parts: [{ text: "hi", type: "text" }], role: "user" },
    ] as UIMessage[]);

test("creates a chat folder for a new Project id and shows it as a standalone project", async () => {
  const { calls, store } = createTestStore();

  const result = await created(store);

  const state = store.getState();
  const project = state.projects.find((item) => item.id === result.projectId);
  assert.ok(project?.standalone);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    name: "createChatFolder",
    request: { projectId: result.projectId },
  });
  assert.equal(
    project.path,
    `${CHATS_ROOT}/2026-11-16-${result.projectId.slice(0, 8)}`,
  );
  assert.equal(state.activeProjectId, result.projectId);
  assert.equal(project.ui.activeChatId, result.chatId);
});

test("a second New chat shows the empty one again without another folder", async () => {
  const { calls, store } = createTestStore();

  const first = await created(store);
  const second = await created(store);

  assert.equal(second.projectId, first.projectId);
  assert.equal(calls.length, 1);
});

test("a new chat after one with messages closes it, stopping its terminals", async () => {
  const { store, stopped } = createTestStore();

  const first = await created(store);
  giveMessage(store, first.chatId as string);
  const second = await created(store);

  const state = store.getState();
  assert.notEqual(second.projectId, first.projectId);
  assert.deepEqual(stopped, [first.projectId]);
  assert.deepEqual(
    state.projects.filter((item) => item.standalone).map((item) => item.id),
    [second.projectId],
  );
  assert.ok(state.closedProjects.some((item) => item.id === first.projectId));

  // Showing the first chat again swaps them back.
  assert.equal(
    await store.getState().showStandaloneChat(first.chatId as string),
    true,
  );
  const shown = store.getState();
  assert.equal(shown.activeProjectId, first.projectId);
  assert.deepEqual(stopped, [first.projectId, second.projectId]);
  assert.equal(
    shown.projects.find((item) => item.id === first.projectId)?.ui.activeChatId,
    first.chatId,
  );
});

test("a refused folder adds nothing and returns the host's error", async () => {
  const { store } = createTestStore({
    createChatFolder: () => {
      throw fakeApiError("createChatFolder", 409, "Inside a Git repository.");
    },
  });

  const result = await store.getState().createStandaloneChat();

  assert.equal(result.ok, false);
  assert.equal(store.getState().projects.length, 1);
});

test("deleting a standalone chat closes its project; purging it removes the project", async () => {
  const { persisted, store, stopped } = createTestStore();

  const { chatId, projectId } = await created(store);
  giveMessage(store, chatId as string);
  store.getState().deleteChat(chatId as string);

  let state = store.getState();
  assert.equal(
    state.projects.some((item) => item.id === projectId),
    false,
  );
  assert.ok(state.closedProjects.some((item) => item.id === projectId));
  assert.deepEqual(stopped, [projectId]);
  assert.equal(
    state.chats.filter((chat) => chat.projectId === projectId).length,
    1,
  );

  store.getState().permanentlyDeleteChats([chatId as string]);

  state = store.getState();
  assert.equal(
    [...state.projects, ...state.closedProjects].some(
      (item) => item.id === projectId,
    ),
    false,
  );
  assert.equal(persisted(), 1);
});

test("showing a chat that is not standalone does nothing", async () => {
  const { store } = createTestStore();
  const plainChat = store.getState().chats[0];

  assert.equal(
    await store.getState().showStandaloneChat(plainChat?.id as string),
    false,
  );
});
