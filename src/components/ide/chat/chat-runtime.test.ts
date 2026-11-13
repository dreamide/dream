import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { clearGeneratedGitText } from "../git-generated-text";
import { useIdeStore } from "../ide-store";
import { CHAT_STREAM_UPDATE_THROTTLE_MS } from "./chat-constants";
import { chatDrafts } from "./chat-drafts";
import {
  CHAT_SESSION_IDLE_EVICT_MS,
  getChatSession,
  getChatSessionView,
  reattachChatStreams,
  retainChatSession,
  startChatRuntime,
  submitChatPrompt,
  subscribeLiveTranscript,
  useChatRuntimeStore,
  watchChatSessionView,
} from "./chat-runtime";

const initialState = useIdeStore.getState();

interface ChatRequest {
  body: Record<string, unknown>;
  url: string;
}

let requests: ChatRequest[] = [];
let hostMessages: unknown[] = [];
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
  hostMessages = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : {},
        url: String(url),
      });
      const pathname = String(url);
      const body = requests.at(-1)?.body ?? {};
      if (pathname === "/api/catalog/changes")
        return Response.json({
          projectIds: [],
          chatIds: [],
          conflicts: [],
          removedProjectIds: [],
          removedChatIds: [],
        });
      if (pathname === "/api/chat/submit") {
        hostMessages = [
          body.message,
          {
            id: "assistant-1",
            role: "assistant",
            parts: [{ type: "text", text: "Done." }],
          },
        ];
        return Response.json({ id: body.requestId, duplicate: false });
      }
      if (pathname === "/api/chat/queue")
        return Response.json({ paused: false, runs: [] });
      if (pathname === "/api/catalog/transcript")
        return Response.json(hostMessages);
      if (pathname === "/api/project-git-status")
        return Response.json({
          changes: [
            { path: "src/app.ts", staged: false, status: "M", unstaged: true },
          ],
        });
      if (pathname === "/api/project-git-commit-message")
        return Response.json({ commitMessage: "Update app" });
      return new Response("{}", { status: 404 });
    }),
  );
});

afterEach(() => {
  stopRuntime();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useIdeStore.setState(initialState, true);
  clearGeneratedGitText();
  useChatRuntimeStore.setState({ errorByChatId: {} });
});

test("a queued submission is sent and saved with no chat panel mounted", async () => {
  const { chat, project } = setUp();

  assert.equal(
    useIdeStore
      .getState()
      .queueChatSubmit(chat.id, { references: [], text: "Fix the login bug" }),
    true,
  );

  await waitFor(() =>
    requests.some((request) => request.url === "/api/chat/submit"),
  );
  const request = requests.find((entry) => entry.url === "/api/chat/submit");
  assert.equal(request?.body.chatId, chat.id);
  assert.equal(request?.body.projectPath, project.path);
  assert.equal(request?.body.model, "claude-test");
  assert.equal(request?.body.provider, "anthropic");

  await waitFor(
    () => useIdeStore.getState().messagesByChatId[chat.id]?.length === 2,
  );
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
  // ...and so does what a panel would show of it.
  await waitFor(() => getChatSessionView(chat.id).status === "ready");
  assert.equal(
    getChatSessionView(chat.id).messages,
    getChatSession(chat.id).chat.messages,
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
  // Back in the chat's draft, though no panel shows the chat.
  assert.equal(chatDrafts.get(chat.id).text, "Make this button blue");
  chatDrafts.clear(chat.id);
  assert.equal(
    requests.some((request) => request.url === "/api/chat/submit"),
    false,
  );
});

test("a chat outside the active project is refused", () => {
  const { chat } = setUp();
  useIdeStore.setState({ activeProjectId: "another-project" });

  assert.throws(
    () => submitChatPrompt(chat.id, { files: [], text: "Hello" }),
    /no longer in the active project/,
  );
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

test("a session publishes its live transcript once per update interval, to shown panels only", () => {
  vi.useFakeTimers();
  const { chat } = setUp();
  const session = getChatSession(chat.id);
  const release = retainChatSession(chat.id);
  const message = (text: string) =>
    [
      { id: "m1", parts: [{ text, type: "text" as const }], role: "user" },
    ] as typeof session.chat.messages;

  let shown = 0;
  const unwatch = watchChatSessionView(chat.id, () => {
    shown += 1;
  });
  const before = getChatSessionView(chat.id);
  for (const text of ["a", "ab", "abc", "abcd"]) {
    session.chat.messages = message(text);
    vi.advanceTimersByTime(5);
  }
  vi.advanceTimersByTime(CHAT_STREAM_UPDATE_THROTTLE_MS);
  const after = getChatSessionView(chat.id);
  assert.notEqual(after, before);
  assert.equal(after.messages, session.chat.messages);
  assert.ok(shown >= 1 && shown <= 2, `told ${shown} times for 4 updates`);

  // Nothing new: the same view, and no one is told.
  const told = shown;
  vi.advanceTimersByTime(CHAT_STREAM_UPDATE_THROTTLE_MS * 4);
  assert.equal(getChatSessionView(chat.id), after);
  assert.equal(shown, told);

  // A panel that stopped watching is not told; the view still moves on.
  unwatch();
  session.chat.messages = message("hidden");
  vi.advanceTimersByTime(CHAT_STREAM_UPDATE_THROTTLE_MS * 2);
  assert.equal(shown, told);
  assert.equal(getChatSessionView(chat.id).messages, session.chat.messages);
  release();
});

test("a hidden panel is never told of its session's changes; a shown one is", () => {
  vi.useFakeTimers();
  const { chat } = setUp();
  const session = getChatSession(chat.id);
  const release = retainChatSession(chat.id);
  let hiddenTold = 0;
  let shownTold = 0;
  const stopHidden = subscribeLiveTranscript(
    chat.id,
    false,
  )(() => {
    hiddenTold += 1;
  });
  const stopShown = subscribeLiveTranscript(
    chat.id,
    true,
  )(() => {
    shownTold += 1;
  });

  session.chat.messages = [
    { id: "m1", parts: [{ text: "hi", type: "text" }], role: "user" },
  ] as typeof session.chat.messages;
  vi.advanceTimersByTime(CHAT_STREAM_UPDATE_THROTTLE_MS * 2);

  assert.equal(hiddenTold, 0);
  assert.equal(shownTold, 1);
  stopHidden();
  stopShown();
  release();
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

test("a dropped response body reconnects to the host turn without a refresh or resubmission", async () => {
  vi.useFakeTimers();
  const { chat } = setUp();
  const transport = globalThis.fetch;
  let streamRequests = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const chunks = (text: string) =>
    [
      { type: "start", messageId: "assistant-1" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: text },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) !== `/api/chat/${chat.id}/stream`)
        return transport(url, init);
      streamRequests++;
      if (streamRequests === 1)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              controller = streamController;
              controller.enqueue(encoder.encode(chunks("Working")));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      hostMessages = [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Done." }],
        },
      ];
      useIdeStore.setState({ hostRunningChatIds: {} });
      return new Response(
        `${chunks("Done.")}data: {"type":"text-end","id":"text-1"}\n\ndata: {"type":"finish"}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  useIdeStore.setState({ hostRunningChatIds: { [chat.id]: true } });
  const session = getChatSession(chat.id);
  await vi.waitFor(() => assert.equal(session.chat.status, "streaming"));
  controller.error(new TypeError("network connection lost"));

  await vi.waitFor(() => assert.equal(session.chat.status, "error"));
  assert.equal(
    (session.chat.messages.at(-1)?.metadata as { completedAt?: string })
      ?.completedAt,
    undefined,
  );

  await vi.waitFor(() => assert.equal(streamRequests, 2), { timeout: 2_000 });
  await vi.waitFor(() => assert.equal(session.chat.status, "ready"));
  assert.deepEqual(
    session.chat.messages
      .at(-1)
      ?.parts.map((part) => (part.type === "text" ? part.text : part.type)),
    ["Done."],
  );
  assert.equal(
    useChatRuntimeStore.getState().errorByChatId[chat.id],
    undefined,
  );
  assert.equal(useIdeStore.getState().streamingChatIds[chat.id], undefined);
  assert.equal(
    requests.some((request) => request.url === "/api/chat/submit"),
    false,
  );
});

test.each([
  "network",
  "unavailable",
])("a failed initial stream request (%s) retries and reconciles a turn that finished offline", async (failure) => {
  vi.useFakeTimers();
  const { chat, project } = setUp();
  const transport = globalThis.fetch;
  let streamRequests = 0;
  let catalogRequests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/catalog") {
        catalogRequests++;
        return Response.json({
          projects: [project],
          chats: [chat],
          runningChatIds: [],
        });
      }
      if (String(url) !== `/api/chat/${chat.id}/stream`)
        return transport(url, init);
      if (++streamRequests === 1) {
        if (failure === "network") throw new TypeError("Failed to fetch");
        return new Response("Host restarting", { status: 503 });
      }
      hostMessages = [
        {
          id: "finished-offline",
          role: "assistant",
          parts: [{ type: "text", text: "Finished while disconnected." }],
        },
      ];
      return new Response(null, { status: 204 });
    }),
  );
  useIdeStore.setState({
    stateHydrated: true,
    hostRunningChatIds: { [chat.id]: true },
  });
  const session = getChatSession(chat.id);

  await vi.waitFor(() => assert.equal(catalogRequests, 1));
  await vi.waitFor(() =>
    assert.equal(session.chat.messages.at(-1)?.id, "finished-offline"),
  );
  assert.equal(streamRequests, 2);
  assert.equal(session.chat.status, "ready");
  assert.equal(useIdeStore.getState().hostRunningChatIds[chat.id], undefined);
  assert.equal(
    useChatRuntimeStore.getState().errorByChatId[chat.id],
    undefined,
  );
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(streamRequests, 2);
});

test.each([
  "refused",
  "provider",
])("a %s error is shown without repeatedly reconnecting", async (failure) => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { chat } = setUp();
  const transport = globalThis.fetch;
  let streamRequests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) !== `/api/chat/${chat.id}/stream`)
        return transport(url, init);
      streamRequests++;
      return failure === "refused"
        ? new Response("Pair this device again", { status: 401 })
        : new Response(
            'data: {"type":"start","messageId":"failed"}\n\ndata: {"type":"error","errorText":"Provider quota exceeded"}\n\ndata: [DONE]\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
    }),
  );
  useIdeStore.setState({ hostRunningChatIds: { [chat.id]: true } });
  const session = getChatSession(chat.id);
  await vi.waitFor(() => assert.equal(session.chat.status, "error"));
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(streamRequests, 1);
  assert.match(
    useChatRuntimeStore.getState().errorByChatId[chat.id],
    failure === "refused" ? /Pair this device/ : /Provider quota/,
  );
});

test("recovery retries back off, deduplicate lifecycle resumes, and stop when the chat is removed", async () => {
  vi.useFakeTimers();
  const { chat } = setUp();
  const transport = globalThis.fetch;
  let streamRequests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) !== `/api/chat/${chat.id}/stream`)
        return transport(url, init);
      streamRequests++;
      throw new TypeError("Failed to fetch");
    }),
  );
  useIdeStore.setState({ hostRunningChatIds: { [chat.id]: true } });
  const session = getChatSession(chat.id);
  await vi.waitFor(() => assert.equal(session.chat.status, "error"));
  await vi.advanceTimersByTimeAsync(250);
  assert.equal(streamRequests, 2);
  await vi.advanceTimersByTimeAsync(250);
  assert.equal(streamRequests, 2);
  reattachChatStreams("local");
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(streamRequests, 3);
  await vi.advanceTimersByTimeAsync(500);
  assert.equal(streamRequests, 3);
  useIdeStore.setState({ chats: [] });
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(streamRequests, 3);
});

test("a lost submit receipt retries the same durable request and attachment payload", async () => {
  const { chat } = setUp();
  const transport = globalThis.fetch;
  let submissions = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const response = await transport(url, init);
      if (String(url) === "/api/chat/submit" && ++submissions === 1)
        throw new TypeError("Connection lost after acceptance");
      return response;
    }),
  );
  const file = {
    type: "file" as const,
    mediaType: "text/plain",
    filename: "context.txt",
    url: "data:text/plain;base64,SGk=",
  };
  assert.equal(
    await submitChatPrompt(chat.id, {
      files: [file],
      text: "Use this context",
    }),
    true,
  );
  const sent = requests.filter((entry) => entry.url === "/api/chat/submit");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].body, sent[1].body);
  assert.deepEqual(
    (sent[0].body.message as { parts: unknown[] }).parts[0],
    file,
  );
});

test("busy chats accept ordered follow-ups; failed acceptance rejects without discarding the caller's draft", async () => {
  const { chat } = setUp();
  useIdeStore.setState({ streamingChatIds: { [chat.id]: true } });
  const first = submitChatPrompt(chat.id, { files: [], text: "First" });
  const second = submitChatPrompt(chat.id, { files: [], text: "Second" });
  await Promise.all([first, second]);
  assert.deepEqual(
    requests
      .filter((entry) => entry.url === "/api/chat/submit")
      .map(
        (entry) =>
          (entry.body.message as { parts: { text: string }[] }).parts[0].text,
      ),
    ["First", "Second"],
  );
  const transport = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      String(url) === "/api/chat/submit"
        ? new Response("Cannot accept submission", { status: 400 })
        : transport(url, init),
    ),
  );
  const prompt = { files: [], text: "Keep this draft" };
  await assert.rejects(
    Promise.resolve(submitChatPrompt(chat.id, prompt)),
    /Cannot accept/,
  );
  assert.equal(prompt.text, "Keep this draft");
});

test("the commit message is generated once the project's last running turn ends", async () => {
  const { chat, project } = setUp();
  const other: ChatConfig = { ...createChatConfig(project), id: "chat-other" };
  useIdeStore.setState((state) => ({ chats: [...state.chats, other] }));
  const generations = () =>
    requests.filter(({ url }) => url === "/api/project-git-commit-message");

  // Neither chat has a session here: their turns ran from elsewhere.
  useIdeStore.getState().setHostTurnRunning(chat.id, true);
  useIdeStore.getState().setHostTurnRunning(other.id, true);
  useIdeStore.getState().setHostTurnRunning(chat.id, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(generations().length, 0, "another turn is still running");

  useIdeStore.getState().setHostTurnRunning(other.id, false);
  await waitFor(() => generations().length === 1);
  assert.equal(generations()[0].body.projectPath, project.path);
});
