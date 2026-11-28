import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { chatTurnOutcomes } from "../chat-turn-outcome";
import { clearGeneratedGitText } from "../git-generated-text";
import { useIdeStore } from "../ide-store";
import { CHAT_STREAM_UPDATE_THROTTLE_MS } from "./chat-constants";
import {
  CHAT_SESSION_IDLE_EVICT_MS,
  getChatSession,
  getChatSessionView,
  reattachChatStreams,
  retainChatSession,
  startChatRuntime,
  subscribeLiveTranscript,
  watchChatSessionView,
} from "./chat-runtime";
import { ENDED_STREAM_GRACE_MS } from "./turn-following";

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

test("a refreshed chat shows its saved history and follows its running turn", async () => {
  vi.useFakeTimers();
  const { chat } = setUp();
  const transport = globalThis.fetch;
  const pageReady = Promise.withResolvers<void>();
  let savedReply = "Work";
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  const send = (chunk: object) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/catalog/transcript/page") {
        await pageReady.promise;
        return Response.json({
          before: "prompt",
          total: 41,
          startIndex: 39,
          messages: [
            {
              id: "prompt",
              role: "user",
              parts: [{ type: "text", text: "Go" }],
            },
            {
              id: "reply",
              role: "assistant",
              parts: [{ type: "text", text: savedReply }],
            },
          ],
        });
      }
      if (url === `/api/chat/${chat.id}/stream`)
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      return transport(url, init);
    }),
  );
  useIdeStore.setState({
    messagesByChatId: {},
    hostRunningChatIds: { [chat.id]: "local" },
  });

  // The panel creates the session during render and asks for the page in an effect.
  getChatSession(chat.id);
  await vi.advanceTimersByTimeAsync(0);
  const loading = useIdeStore.getState().loadRecentMessagesForChat(chat.id);
  await vi.advanceTimersByTimeAsync(0);
  pageReady.resolve();
  send({ type: "start", messageId: "reply" });
  send({ type: "text-start", id: "text" });
  send({ type: "text-delta", id: "text", delta: "Working" });

  try {
    await loading;
    await vi.waitFor(() => {
      const view = getChatSessionView(chat.id);
      assert.equal(view.status, "streaming");
      assert.equal(view.messages.at(-1)?.id, "reply");
    });
    // The panel gates its conversation on the transcript being loaded.
    const state = useIdeStore.getState();
    assert.ok(Object.hasOwn(state.messagesByChatId, chat.id));
    assert.equal(state.transcriptPageByChatId[chat.id]?.before, "prompt");
    assert.deepEqual(
      getChatSessionView(chat.id).messages.map((message) => message.id),
      ["prompt", "reply"],
    );

    send({ type: "text-delta", id: "text", delta: " on it." });
    await vi.waitFor(() => {
      const part = getChatSessionView(chat.id).messages.at(-1)?.parts[0];
      assert.equal(part?.type === "text" && part.text, "Working on it.");
    });
  } finally {
    savedReply = "Working on it.";
    send({ type: "text-end", id: "text" });
    send({ type: "finish" });
    useIdeStore.setState({ hostRunningChatIds: {} });
    controller.close();
    await vi.waitFor(() => {
      assert.equal(useIdeStore.getState().streamingChatIds[chat.id], undefined);
    });
  }
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
  useIdeStore.setState({ hostRunningChatIds: { [chat.id]: "local" } });
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
  assert.equal(chatTurnOutcomes.store.getState().errors[chat.id], undefined);
  assert.equal(useIdeStore.getState().streamingChatIds[chat.id], undefined);
  assert.equal(
    requests.some((request) => request.url === "/api/chat/submit"),
    false,
  );
});

test("a stream that stalls after its turn ends settles on the saved transcript", async () => {
  vi.useFakeTimers();
  const { chat } = setUp();
  const transport = globalThis.fetch;
  let streamRequests = 0;
  const encoder = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) !== `/api/chat/${chat.id}/stream`)
        return transport(url, init);
      streamRequests++;
      // The stream delivers the turn's start, then nothing more: it never
      // closes, though the turn goes on to finish on the host.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  { type: "start", messageId: "assistant-1" },
                  { type: "text-start", id: "text-1" },
                  { type: "text-delta", id: "text-1", delta: "Working" },
                ]
                  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
                  .join(""),
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  useIdeStore.setState({ hostRunningChatIds: { [chat.id]: "local" } });
  const session = getChatSession(chat.id);
  await vi.waitFor(() => assert.equal(session.chat.status, "streaming"));

  // The host saves the finished turn and says it ended.
  hostMessages = [
    {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Done." }],
    },
  ];
  useIdeStore.setState({ hostRunningChatIds: {} });
  await vi.advanceTimersByTimeAsync(ENDED_STREAM_GRACE_MS - 100);
  assert.equal(session.chat.status, "streaming", "a grace period first");

  await vi.advanceTimersByTimeAsync(100);
  await vi.waitFor(() =>
    assert.deepEqual(
      session.chat.messages
        .at(-1)
        ?.parts.map((part) => (part.type === "text" ? part.text : part.type)),
      ["Done."],
    ),
  );
  assert.equal(session.chat.status, "ready");
  assert.equal(useIdeStore.getState().streamingChatIds[chat.id], undefined);
  assert.equal(
    chatTurnOutcomes.store.getState().turns[chat.id]?.status,
    "finished",
  );
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(streamRequests, 1, "an ended turn is not followed again");
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
    hostRunningChatIds: { [chat.id]: "local" },
  });
  const session = getChatSession(chat.id);

  await vi.waitFor(() => assert.equal(catalogRequests, 1));
  await vi.waitFor(() =>
    assert.equal(session.chat.messages.at(-1)?.id, "finished-offline"),
  );
  assert.equal(streamRequests, 2);
  assert.equal(session.chat.status, "ready");
  assert.equal(useIdeStore.getState().hostRunningChatIds[chat.id], undefined);
  assert.equal(chatTurnOutcomes.store.getState().errors[chat.id], undefined);
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
  useIdeStore.setState({ hostRunningChatIds: { [chat.id]: "local" } });
  const session = getChatSession(chat.id);
  await vi.waitFor(() => assert.equal(session.chat.status, "error"));
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(streamRequests, 1);
  assert.match(
    chatTurnOutcomes.store.getState().errors[chat.id],
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
  useIdeStore.setState({ hostRunningChatIds: { [chat.id]: "local" } });
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

test("the commit message is generated once the project's last running turn ends", async () => {
  const { chat, project } = setUp();
  const other: ChatConfig = { ...createChatConfig(project), id: "chat-other" };
  useIdeStore.setState((state) => ({ chats: [...state.chats, other] }));
  const generations = () =>
    requests.filter(({ url }) => url === "/api/project-git-commit-message");

  // Neither chat has a session here: their turns ran from elsewhere.
  useIdeStore.setState({ hostRunningChatIds: { [chat.id]: "local" } });
  useIdeStore.setState({
    hostRunningChatIds: { [chat.id]: "local", [other.id]: "local" },
  });
  useIdeStore.setState({ hostRunningChatIds: { [other.id]: "local" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(generations().length, 0, "another turn is still running");

  useIdeStore.setState({ hostRunningChatIds: {} });
  await waitFor(() => generations().length === 1);
  assert.equal(generations()[0].body.projectPath, project.path);
});
