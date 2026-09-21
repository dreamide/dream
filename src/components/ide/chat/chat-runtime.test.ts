import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import {
  CHAT_SESSION_IDLE_EVICT_MS,
  getChatSession,
  retainChatSession,
  startChatRuntime,
  submitChatPrompt,
  takeChatDraftRestore,
  useChatRuntimeStore,
} from "./chat-runtime";

const initialState = useIdeStore.getState();

const sseResponse = (chunks: object[]) =>
  new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );

const assistantReply = (text: string) =>
  sseResponse([
    { messageId: "assistant-1", type: "start" },
    { id: "text-1", type: "text-start" },
    { delta: text, id: "text-1", type: "text-delta" },
    { id: "text-1", type: "text-end" },
    { type: "finish" },
  ]);

interface ChatRequest {
  body: Record<string, unknown>;
  url: string;
}

let requests: ChatRequest[] = [];
let stopRuntime: () => void = () => {};

const setUp = ({ installed = true }: { installed?: boolean } = {}) => {
  const settings = {
    ...DEFAULT_SETTINGS,
    anthropicSelectedModels: ["claude-test"],
  };
  const project: ProjectConfig = createProjectConfig(
    "/workspace/app",
    settings,
  );
  const chat: ChatConfig = {
    ...createChatConfig(project, { title: "Existing title" }),
    model: "claude-test",
    provider: "anthropic",
  };

  useIdeStore.setState({
    activeProjectId: project.id,
    chats: [chat],
    messagesByChatId: { [chat.id]: [] },
    projects: [project],
    providerModels: {
      ...initialState.providerModels,
      anthropic: { ...initialState.providerModels.anthropic, installed },
    },
    settings,
  });
  stopRuntime = startChatRuntime();
  return { chat, project };
};

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for the chat runtime.");
};

beforeEach(() => {
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : {},
        url: String(url),
      });
      return String(url) === "/api/chat"
        ? assistantReply("Done.")
        : new Response("{}", { status: 404 });
    }),
  );
});

afterEach(() => {
  stopRuntime();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useIdeStore.setState(initialState, true);
  useChatRuntimeStore.setState({ draftRestoreByChatId: {}, errorByChatId: {} });
});

test("a queued submission is sent and saved with no chat panel mounted", async () => {
  const { chat, project } = setUp();

  assert.equal(
    useIdeStore
      .getState()
      .queueChatSubmit(chat.id, { references: [], text: "Fix the login bug" }),
    true,
  );

  await waitFor(() => requests.some((request) => request.url === "/api/chat"));
  const request = requests.find((entry) => entry.url === "/api/chat");
  assert.equal(request?.body.chatId, chat.id);
  assert.equal(request?.body.projectPath, project.path);
  assert.equal(request?.body.model, "claude-test");
  assert.equal(request?.body.provider, "anthropic");

  await waitFor(() => !useIdeStore.getState().streamingChatIds[chat.id]);
  const state = useIdeStore.getState();
  assert.equal(state.pendingChatSubmitByChatId[chat.id], undefined);
  assert.deepEqual(
    state.messagesByChatId[chat.id]?.map((message) => message.role),
    ["user", "assistant"],
  );
  // The session and the store agree on the finished transcript.
  assert.deepEqual(
    getChatSession(chat.id).chat.messages,
    state.messagesByChatId[chat.id],
  );
});

test("a queued submission that cannot be sent returns to the draft", async () => {
  const { chat } = setUp({ installed: false });

  useIdeStore.getState().queueChatSubmit(chat.id, {
    preserveDraft: true,
    references: [],
    text: "Make this button blue",
  });

  await waitFor(() =>
    Boolean(useChatRuntimeStore.getState().errorByChatId[chat.id]),
  );
  assert.match(
    useChatRuntimeStore.getState().errorByChatId[chat.id],
    /Anthropic CLI is not available/,
  );
  assert.equal(takeChatDraftRestore(chat.id), "Make this button blue");
  assert.equal(takeChatDraftRestore(chat.id), null);
  assert.equal(
    requests.some((request) => request.url === "/api/chat"),
    false,
  );
});

test("a chat outside the active project is refused unless a task runs it", () => {
  const { chat } = setUp();
  useIdeStore.setState({ activeProjectId: "another-project" });

  assert.throws(
    () => submitChatPrompt(chat.id, { files: [], text: "Hello" }),
    /no longer in the active project/,
  );

  useIdeStore.setState({
    tasks: [
      {
        runs: [{ chatId: chat.id }],
      } as unknown as ReturnType<typeof useIdeStore.getState>["tasks"][number],
    ],
  });
  assert.equal(submitChatPrompt(chat.id, { files: [], text: "Hello" }), true);
});

test("an idle session is dropped only after its last watcher leaves", () => {
  vi.useFakeTimers();
  const { chat } = setUp();

  const session = getChatSession(chat.id);
  const release = retainChatSession(chat.id);
  vi.advanceTimersByTime(CHAT_SESSION_IDLE_EVICT_MS * 2);
  assert.equal(getChatSession(chat.id), session);

  release();
  vi.advanceTimersByTime(CHAT_SESSION_IDLE_EVICT_MS + 1);
  assert.notEqual(getChatSession(chat.id), session);
});

test("a session follows a transcript the store loads later", () => {
  const { chat } = setUp();
  useIdeStore.setState({ messagesByChatId: {} });
  const session = getChatSession(chat.id);
  assert.deepEqual(session.chat.messages, []);

  const loaded = [
    { id: "m1", parts: [{ text: "hi", type: "text" as const }], role: "user" },
  ] as ReturnType<typeof getChatSession>["chat"]["messages"];
  useIdeStore.setState({ messagesByChatId: { [chat.id]: loaded } });

  assert.deepEqual(getChatSession(chat.id).chat.messages, loaded);
});
