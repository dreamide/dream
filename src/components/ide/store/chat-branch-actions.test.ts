import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import { createChatActions } from "./chat-actions";
import type { IdeState } from "./ide-store-types";
import { createProjectLifecycleActions } from "./project-lifecycle-actions";

const createTestStore = () => {
  const project = createProjectConfig("/workspace/source", DEFAULT_SETTINGS);
  const sourceChat = {
    ...createChatConfig(project, { title: "Source chat" }),
    remoteConversationId: "remote-session",
    remoteConversationModel: "remote-model",
    remoteConversationModelSpeed: "fast" as const,
    remoteConversationProjectPath: project.path,
  };
  project.ui = {
    ...project.ui,
    activeChatId: sourceChat.id,
    openChatIds: [sourceChat.id],
  };
  const messages = [
    {
      id: "message-one",
      parts: [{ text: "one", type: "text" }],
      role: "user",
    },
    {
      id: "message-two",
      parts: [{ text: "two", type: "text" }],
      role: "assistant",
    },
    {
      id: "message-three",
      parts: [{ text: "three", type: "text" }],
      role: "user",
    },
  ] as UIMessage[];
  const store = createStore<IdeState>(
    () =>
      ({
        activeProjectId: project.id,
        chats: [sourceChat],
        chatSort: "recent",
        closedProjects: [],
        completedChatIds: {},
        draftChatIdByProject: {},
        messagesByChatId: { [sourceChat.id]: messages },
        projects: [project],
        settings: DEFAULT_SETTINGS,
        streamingChatIds: {},
        titleGeneratingChatIds: {},
      }) as unknown as IdeState,
  );
  store.setState({
    ...createProjectLifecycleActions(store.setState, store.getState),
    ...createChatActions(store.setState, store.getState),
  });

  return { messages, project, sourceChat, store };
};

test("branches a transcript prefix without mutating the source", () => {
  const { messages, project, sourceChat, store } = createTestStore();
  const sourceState = store.getState();
  const branchId = sourceState.branchChatInWorkspace({
    chatId: sourceChat.id,
    messageId: "message-two",
  });
  const state = store.getState();
  const branch = state.chats.find((chat) => chat.id === branchId);

  assert.equal(state.chats.length, 2);
  assert.equal(state.messagesByChatId[sourceChat.id], messages);
  assert.deepEqual(state.messagesByChatId[branchId], messages.slice(0, 2));
  assert.notEqual(state.messagesByChatId[branchId][0], messages[0]);
  assert.deepEqual(branch?.branchedFrom, {
    chatId: sourceChat.id,
    messageId: "message-two",
  });
  assert.equal(branch?.remoteConversationId, null);
  assert.equal(state.projects[0].ui.activeChatId, branchId);
  assert.deepEqual(state.projects[0].ui.openChatIds, [branchId]);
  assert.equal(state.activeProjectId, project.id);
});

test("branch failures and streaming leave chat state unchanged", () => {
  const { sourceChat, store } = createTestStore();
  const originalState = store.getState();

  assert.throws(() =>
    originalState.branchChatInWorkspace({
      chatId: sourceChat.id,
      messageId: "missing",
    }),
  );
  assert.equal(store.getState().chats, originalState.chats);

  store.setState({ streamingChatIds: { [sourceChat.id]: true } });
  assert.throws(
    () =>
      store.getState().branchChatInWorkspace({
        chatId: sourceChat.id,
        messageId: "message-one",
      }),
    /while it is streaming/,
  );
  assert.equal(store.getState().chats, originalState.chats);
});

test("worktree creation adds exactly one seeded branch chat", async () => {
  const { project, sourceChat, store } = createTestStore();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        baseRef: "main",
        branch: "source-branch",
        mainWorktreePath: "/workspace/source",
        path: "/workspace/worktrees/source-branch",
        repoRoot: "/workspace/source",
      }),
    ),
  );

  try {
    const result = await store.getState().createWorktreeProject(project.id, {
      baseRef: "main",
      branchName: "source-branch",
      initialChatSeed: {
        messageId: "message-two",
        messages: structuredClone(
          store.getState().messagesByChatId[sourceChat.id].slice(0, 2),
        ),
        sourceChat: structuredClone(sourceChat),
      },
    });
    const state = store.getState();
    const branch = state.chats.find((chat) => chat.id === result?.chatId);

    assert.equal(state.projects.length, 2);
    assert.equal(state.chats.length, 2);
    assert.equal(branch?.projectId, result?.projectId);
    assert.deepEqual(branch?.branchedFrom, {
      chatId: sourceChat.id,
      messageId: "message-two",
    });
    assert.equal(state.messagesByChatId[branch?.id ?? ""]?.length, 2);
    assert.equal(state.draftChatIdByProject[result?.projectId ?? ""], null);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a failed worktree request leaves project and chat state unchanged", async () => {
  const { project, store } = createTestStore();
  const originalState = store.getState();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("branch exists", { status: 409 })),
  );

  try {
    await assert.rejects(() =>
      store.getState().createWorktreeProject(project.id, {
        branchName: "existing-branch",
      }),
    );
    assert.equal(store.getState().projects, originalState.projects);
    assert.equal(store.getState().chats, originalState.chats);
    assert.equal(
      store.getState().messagesByChatId,
      originalState.messagesByChatId,
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
