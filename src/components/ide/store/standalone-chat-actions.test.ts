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
import { createCatalogActions } from "./catalog-actions";
import { createChatActions } from "./chat-actions";
import type { IdeState } from "./ide-store-types";
import {
  startNavigationHistoryTracking,
  useNavigationHistoryStore,
} from "./navigation-history-store";
import { createProjectLifecycleActions } from "./project-lifecycle-actions";
import { createStandaloneChatActions } from "./standalone-chat-actions";

const CHATS_ROOT = "/home/me/.dream/chats";

const createTestStore = (
  handlers: FakeApiHandlers = {},
  reach?: (hostId: string) => Promise<boolean>,
) => {
  const api = createFakeApiClient({
    createChatFolder: ({ projectId }) => ({
      path: `${CHATS_ROOT}/2026-11-16-${projectId.slice(0, 8)}`,
    }),
    ...handlers,
  });
  const plain = createProjectConfig("/workspace/app", DEFAULT_SETTINGS);
  const stopped: string[] = [];
  let persisted = 0;
  const persist = () => {
    persisted += 1;
  };
  const terminals = {
    dropProject: async (projectId: string) => {
      stopped.push(projectId);
    },
  };

  const store = createStore<IdeState>(
    () =>
      ({
        activeBrowserTabIdByProject: {},
        activeProjectId: null,
        activeTerminalSessionIdByProject: {},
        awaitingAnswerChatIds: {},
        browserStatusByTab: {},
        browserTabsByProject: {},
        chats: [],
        chatSort: "recent",
        closedProjects: [],
        draftChatIdByProject: {},
        gitWriteByProject: {},
        hosts: {},
        messagesByChatId: {},
        nextTerminalOrdinalByProject: {},
        sendingChatIds: {},
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
    ...createProjectLifecycleActions(store.setState, store.getState, {
      hosts: reach ? { reach } : undefined,
      persist,
      terminals,
    }),
    ...createChatActions(store.setState, store.getState, {
      api: api.client,
      persist,
      terminals,
    }),
    ...createStandaloneChatActions(store.setState, store.getState, {
      api: api.client,
      terminals,
    }),
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
    await store.getState().revealChat(first.chatId as string, "standalone"),
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
    await store.getState().revealChat(plainChat?.id as string, "standalone"),
    false,
  );
});

test("a catalog purge during Host reach leaves the current selection intact", async () => {
  const ready = Promise.withResolvers<boolean>();
  const { store } = createTestStore({}, () => ready.promise);
  const target = await created(store);
  giveMessage(store, target.chatId as string);
  const current = await created(store);
  store.setState({ stateHydrated: true });
  const opening = store
    .getState()
    .revealChat(target.chatId as string, "standalone");
  const catalog = createCatalogActions(store.setState, store.getState, {
    persist: () => {},
    terminals: { dropProject: async () => {} },
  });
  catalog.applyCatalogChanges({ removedProjectIds: [target.projectId] });
  const afterPurge = store.getState();
  ready.resolve(true);
  assert.equal(await opening, false);
  assert.equal(store.getState(), afterPurge);
  assert.equal(afterPurge.activeProjectId, current.projectId);
});

test("search restores a closed Project's deleted Chat in one navigation visit", async () => {
  const { store } = createTestStore();
  const firstProject = store.getState().projects[0];
  const targetId = store
    .getState()
    .addChat(firstProject.id, undefined, { forceNew: true });
  assert.ok(targetId);
  giveMessage(store, targetId);
  store.getState().deleteChat(targetId);
  store.getState().addProject("/workspace/second");
  store.getState().closeProject(firstProject.id);
  store.setState({ stateHydrated: true });
  const originalHistory = useNavigationHistoryStore.getState().history;
  const stop = startNavigationHistoryTracking(store);
  try {
    assert.equal(await store.getState().revealChat(targetId, "open"), false);
    const visits = useNavigationHistoryStore.getState().history.entries.length;
    assert.equal(await store.getState().revealChat(targetId, "search"), true);
    assert.deepEqual(
      useNavigationHistoryStore.getState().history.entries.slice(visits),
      [{ projectId: firstProject.id, chatId: targetId }],
    );
    assert.equal(
      store.getState().chats.find((chat) => chat.id === targetId)?.deletedAt,
      null,
    );
  } finally {
    stop();
    useNavigationHistoryStore.setState({ history: originalHistory });
  }
});

test("turning a standalone chat into a project names it after the chat and shows it", async () => {
  const { calls, store } = createTestStore();
  const { chatId, projectId } = await created(store);
  giveMessage(store, chatId as string);
  store.getState().updateChat(chatId as string, (chat) => ({
    ...chat,
    title: "Release notes",
  }));

  assert.equal(store.getState().promoteStandaloneChat(chatId as string), true);

  const project = store
    .getState()
    .projects.find((item) => item.id === projectId);
  assert.equal(project?.standalone, null);
  assert.equal(project?.name, "Release notes");
  assert.equal(store.getState().activeProjectId, projectId);
  // The folder stays where it is: no host call.
  assert.equal(calls.length, 1);
  assert.equal(store.getState().promoteStandaloneChat(chatId as string), false);
});
