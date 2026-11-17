import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { createStore } from "zustand/vanilla";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { SendChatMessage } from "../chat/chat-submission";
import { createChatActions } from "./chat-actions";
import { setChatSubmitter } from "./chat-submitter";
import type { IdeState } from "./ide-store-types";
import { createSavedPromptActions } from "./saved-prompt-actions";
import { createStashActions } from "./stash-actions";

const createTestStore = () => {
  const project = createProjectConfig("/workspace/dream", DEFAULT_SETTINGS);
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
        savedPrompts: [],
        titleGeneratingChatIds: {},
      }) as unknown as IdeState,
  );
  store.setState({
    ...createChatActions(store.setState, store.getState),
    ...createStashActions(store.setState, store.getState),
    ...createSavedPromptActions(store.setState, store.getState),
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

test("addSavedPrompt saves a trimmed prompt and refuses one without a name or prompt", () => {
  const { store } = createTestStore();

  const promptId = store
    .getState()
    .addSavedPrompt({ prompt: "  Address the review  ", name: " Review " });
  assert.ok(promptId);
  assert.equal(
    store.getState().addSavedPrompt({ prompt: "x", name: " " }),
    null,
  );
  assert.equal(
    store.getState().addSavedPrompt({ prompt: " ", name: "x" }),
    null,
  );

  const { savedPrompts } = store.getState();
  assert.equal(savedPrompts.length, 1);
  assert.equal(savedPrompts[0]?.id, promptId);
  assert.equal(savedPrompts[0]?.name, "Review");
  assert.equal(savedPrompts[0]?.prompt, "Address the review");
});

test("updateSavedPrompt edits in place and ignores blank values", () => {
  const { store } = createTestStore();
  const promptId = store
    .getState()
    .addSavedPrompt({ prompt: "Old prompt", name: "Old" }) as string;
  const before = store.getState().savedPrompts[0];

  store
    .getState()
    .updateSavedPrompt(promptId, { prompt: "New prompt", name: " " });

  const after = store.getState().savedPrompts[0];
  assert.equal(after?.name, "Old");
  assert.equal(after?.prompt, "New prompt");
  assert.equal(after?.createdAt, before?.createdAt);

  // Nothing changed: the list is left as is.
  const savedPrompts = store.getState().savedPrompts;
  store.getState().updateSavedPrompt(promptId, { name: "Old" });
  assert.equal(store.getState().savedPrompts, savedPrompts);
});

test("moveSavedPrompt reorders and deleteSavedPrompt removes", () => {
  const { store } = createTestStore();
  const ids = ["One", "Two", "Three"].map(
    (name) => store.getState().addSavedPrompt({ prompt: name, name }) as string,
  );

  store.getState().moveSavedPrompt(ids[2] as string, 0);
  assert.deepEqual(
    store.getState().savedPrompts.map((savedPrompt) => savedPrompt.name),
    ["Three", "One", "Two"],
  );
  store.getState().moveSavedPrompt(ids[2] as string, 99);
  assert.deepEqual(
    store.getState().savedPrompts.map((savedPrompt) => savedPrompt.name),
    ["One", "Two", "Three"],
  );

  store.getState().deleteSavedPrompt(ids[1] as string);
  assert.deepEqual(
    store.getState().savedPrompts.map((savedPrompt) => savedPrompt.name),
    ["One", "Three"],
  );
});

test("runSavedPrompt sends the prompt to the chat as written and keeps the saved prompt", async () => {
  const { project, sent, store } = createTestStore();
  const chatId = store.getState().addChat(project.id) as string;
  const promptId = store.getState().addSavedPrompt({
    prompt: "Address the review comments on {{branch}}",
    name: "Review",
  }) as string;

  assert.deepEqual(
    await store.getState().runSavedPrompt(project.id, promptId, chatId),
    { status: "sent" },
  );
  assert.deepEqual(sent, [
    [
      chatId,
      { references: [], text: "Address the review comments on {{branch}}" },
      { origin: "saved-prompt" },
    ],
  ]);
  // Running a saved prompt never uses it up.
  assert.equal(store.getState().savedPrompts.length, 1);
});

test("runSavedPrompt sends nothing to a chat of another project or a deleted one", () => {
  const { project, sent, store } = createTestStore();
  const chatId = store.getState().addChat(project.id) as string;
  const promptId = store
    .getState()
    .addSavedPrompt({ prompt: "Run the tests", name: "Test" }) as string;

  assert.equal(
    store.getState().runSavedPrompt("other-project", promptId, chatId),
    null,
  );
  store.getState().updateChat(chatId, (chat) => ({
    ...chat,
    deletedAt: new Date().toISOString(),
  }));
  assert.equal(
    store.getState().runSavedPrompt(project.id, promptId, chatId),
    null,
  );
  assert.deepEqual(sent, []);
});
