import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { createStore } from "zustand/vanilla";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { SendChatMessage } from "../chat/chat-submission";
import { createChatActions } from "./chat-actions";
import { setChatSubmitter } from "./chat-submitter";
import type { IdeState } from "./ide-store-types";
import { createStashActions } from "./stash-actions";

const createTestStore = () => {
  const project = createProjectConfig("/workspace/source", DEFAULT_SETTINGS);
  const store = createStore<IdeState>(
    () =>
      ({
        activeProjectId: project.id,
        chats: [],
        chatSort: "recent",
        closedProjects: [],
        draftChatIdByProject: {},
        messagesByChatId: {},
        sendingChatIds: {},
        projects: [project],
        settings: DEFAULT_SETTINGS,
        streamingChatIds: {},
        titleGeneratingChatIds: {},
      }) as unknown as IdeState,
  );
  store.setState({
    ...createChatActions(store.setState, store.getState),
    ...createStashActions(store.setState, store.getState),
  });

  // What the store sends, through the submitter Chat submission registers.
  const sent: Parameters<SendChatMessage>[] = [];
  setChatSubmitter(async (...args) => {
    sent.push(args);
    return { status: "sent" };
  });

  return { project, sent, store };
};

afterEach(() => {
  setChatSubmitter(null);
});

test("adds, updates, and deletes stash items", () => {
  const { project, store } = createTestStore();

  const itemId = store.getState().addStashItem(project.id, {
    model: "gpt-5",
    modelSpeed: "standard",
    permissionMode: "full-access",
    provider: "openai",
    reasoningEffort: null,
    references: [],
    text: "  first task  ",
  });

  assert.ok(itemId);
  const added = store
    .getState()
    .projects[0]?.ui.stashItems.find((item) => item.id === itemId);
  assert.equal(added?.text, "first task");

  store.getState().updateStashItem(project.id, itemId, (item) => ({
    ...item,
    text: "updated task",
  }));

  const updated = store
    .getState()
    .projects[0]?.ui.stashItems.find((item) => item.id === itemId);
  assert.equal(updated?.text, "updated task");

  store.getState().deleteStashItem(project.id, itemId);
  assert.deepEqual(store.getState().projects[0]?.ui.stashItems, []);
});

test("executeStashItem opens a new chat and sends the prompt to it", () => {
  const { project, sent, store } = createTestStore();
  const itemId = store.getState().addStashItem(project.id, {
    model: "gpt-5",
    modelSpeed: "fast",
    permissionMode: "ask",
    provider: "openai",
    reasoningEffort: "high",
    references: [],
    text: "run this later",
  });
  assert.ok(itemId);

  const draftId = store.getState().addChat(project.id);
  const chatId = store.getState().executeStashItem(project.id, itemId);
  assert.ok(chatId);
  assert.notEqual(chatId, draftId);

  const state = store.getState();
  const chat = state.chats.find((item) => item.id === chatId);
  assert.equal(chat?.model, "gpt-5");
  assert.equal(chat?.modelSpeed, "fast");
  assert.equal(chat?.permissionMode, "ask");
  assert.deepEqual(sent, [
    [chatId, { references: [], text: "run this later" }, { origin: "stash" }],
  ]);
  assert.deepEqual(state.projects[0]?.ui.stashItems, []);
  assert.equal(state.projects[0]?.ui.activeChatId, chatId);
  assert.deepEqual(state.projects[0]?.ui.openChatIds, [chatId]);
});

test("executeStashItem adds a chat beside open chats in multi-chat mode", () => {
  const { project, store } = createTestStore();
  const firstChatId = store.getState().addChat(project.id);
  assert.ok(firstChatId);
  store.getState().addChatBeside(project.id);

  const itemId = store.getState().addStashItem(project.id, {
    model: "gpt-5",
    modelSpeed: "standard",
    permissionMode: "full-access",
    provider: "openai",
    reasoningEffort: null,
    references: [],
    text: "queued beside",
  });
  assert.ok(itemId);

  const openBefore = store.getState().projects[0]?.ui.openChatIds ?? [];
  const chatId = store.getState().executeStashItem(project.id, itemId);
  assert.ok(chatId);

  const openAfter = store.getState().projects[0]?.ui.openChatIds ?? [];
  assert.equal(store.getState().projects[0]?.ui.multiChat, true);
  assert.deepEqual(openAfter, [...openBefore, chatId]);
  assert.equal(store.getState().projects[0]?.ui.activeChatId, chatId);
});
