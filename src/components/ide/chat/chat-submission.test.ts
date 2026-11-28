// Chat submission through its entry point, over the real chat runtime and
// store with the host's routes stubbed: each refusal, a send, and a send
// that fails.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { connectionSupervisor } from "@/lib/connections/runtime";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import {
  ALL_PROVIDERS,
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { chatTurnOutcomes } from "../chat-turn-outcome";
import { clearGeneratedGitText } from "../git-generated-text";
import { useIdeStore } from "../ide-store";
import { chatDrafts } from "./chat-drafts";
import {
  getChatSession,
  getChatSessionView,
  startChatRuntime,
} from "./chat-runtime";
import {
  type ChatSendRefusal,
  type ChatSendResult,
  sendChatMessage,
} from "./chat-submission";

const initialState = useIdeStore.getState();

interface ChatRequest {
  body: Record<string, unknown>;
  url: string;
}

let requests: ChatRequest[] = [];
let hostMessages: unknown[] = [];
let stopRuntime: () => void = () => {};
let chatIds: string[] = [];

const setUp = () => {
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
  chatIds.push(chat.id);

  useIdeStore.setState({
    activeProjectId: project.id,
    chats: [chat],
    messagesByChatId: { [chat.id]: [] },
    projects: [project],
    providerModels: {
      ...initialState.providerModels,
      anthropic: { ...initialState.providerModels.anthropic, installed: true },
    },
    settings,
    // The home host is ready: hydrated, its connection up.
    stateHydrated: true,
  });
  connectionSupervisor.set(LOCAL_HOST_ID, "ready");
  stopRuntime = startChatRuntime();
  return { chat, project };
};

const submits = () =>
  requests.filter((request) => request.url === "/api/chat/submit");
const sentTexts = () =>
  submits().map(
    (request) =>
      (request.body.message as { parts: { text: string }[] }).parts[0].text,
  );
const bannerOf = (chatId: string) =>
  chatTurnOutcomes.store.getState().errors[chatId] ?? null;

const waitFor = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
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
        return Response.json({ changes: [] });
      return new Response("{}", { status: 404 });
    }),
  );
});

afterEach(() => {
  stopRuntime();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const chatId of chatIds) {
    chatDrafts.sent(chatId, chatDrafts.get(chatId));
    chatTurnOutcomes.reportError(chatId, null);
  }
  chatIds = [];
  useIdeStore.setState(initialState, true);
  connectionSupervisor.forget(LOCAL_HOST_ID);
  clearGeneratedGitText();
});

test("a message from outside the composer is sent and saved with no chat panel mounted", async () => {
  const { chat, project } = setUp();

  const result = await sendChatMessage(
    chat.id,
    { references: [], text: "Fix the login bug" },
    { origin: "stash" },
  );

  assert.deepEqual(result, { status: "sent" });
  const [request] = submits();
  assert.equal(request?.body.chatId, chat.id);
  assert.equal(request?.body.projectPath, project.path);
  assert.equal(request?.body.model, "claude-test");
  assert.equal(request?.body.provider, "anthropic");
  // Sent: nothing is being sent any more, and the chat is the active one.
  assert.equal(useIdeStore.getState().sendingChatIds[chat.id], undefined);
  assert.equal(useIdeStore.getState().projects[0]?.ui.activeChatId, chat.id);

  await waitFor(
    () => useIdeStore.getState().messagesByChatId[chat.id]?.length === 2,
  );
  const state = useIdeStore.getState();
  assert.deepEqual(
    state.messagesByChatId[chat.id]?.map((message) => message.role),
    ["user", "assistant"],
  );
  // The session and the store agree on the finished transcript...
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

test("the composer's message is its chat's draft, emptied once sent", async () => {
  const { chat } = setUp();
  chatDrafts.set(chat.id, { references: [], text: "Use $review here" });

  const result = await sendChatMessage(
    chat.id,
    { files: [], references: [], skills: ["review"], text: "Use $review here" },
    { origin: "composer" },
  );

  assert.deepEqual(result, { status: "sent" });
  assert.equal(chatDrafts.get(chat.id).text, "");
  // The skills the composer recognised are shown on the sent message.
  const [request] = submits();
  assert.deepEqual(
    (request?.body.message as { metadata: { skillMentions: string[] } })
      .metadata.skillMentions,
    ["review"],
  );
});

test.each([
  true,
  false,
])("feedback survives an overlapping composer send (accepted %s)", async (accepted) => {
  const { chat } = setUp();
  const transport = globalThis.fetch;
  const receipt = Promise.withResolvers<void>();
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url) === "/api/chat/submit") {
      await receipt.promise;
      if (!accepted) return new Response("Refused", { status: 400 });
    }
    return transport(url, init);
  });
  const draft = { text: "First", references: [] };
  chatDrafts.set(chat.id, draft);
  const first = sendChatMessage(chat.id, draft, { origin: "composer", draft });
  const feedback = await sendChatMessage(
    chat.id,
    { text: "Review this line", references: [] },
    { origin: "feedback" },
  );
  assert.equal(feedback.status === "refused" && feedback.reason, "busy");
  assert.equal(chatDrafts.get(chat.id).text, "First\n\nReview this line");

  receipt.resolve();
  assert.equal((await first).status, accepted ? "sent" : "failed");
  assert.equal(
    chatDrafts.get(chat.id).text,
    accepted ? "Review this line" : "First\n\nReview this line",
  );
});

test("an edit made during Chat submission is still the live draft after success", async () => {
  const { chat } = setUp();
  const draft = { text: "Original", references: [] };
  const revised = { text: "Original, revised", references: [] };
  chatDrafts.set(chat.id, draft);
  const sending = sendChatMessage(chat.id, draft, {
    origin: "composer",
    draft,
  });
  chatDrafts.set(chat.id, revised);
  assert.deepEqual(await sending, { status: "sent" });
  assert.equal(chatDrafts.get(chat.id), revised);
});

test("each refusal is a value, says why on the banner, and sends nothing", async () => {
  const cases: [
    ChatSendRefusal,
    (chat: ChatConfig, project: ProjectConfig) => void,
    string | null,
  ][] = [
    [
      "not-in-active-project",
      () => useIdeStore.setState({ activeProjectId: "another-project" }),
      "This chat is no longer in the active project. Switch back to this project and try again.",
    ],
    [
      "not-in-active-project",
      (chat) =>
        useIdeStore.getState().updateChat(chat.id, (current) => ({
          ...current,
          deletedAt: new Date().toISOString(),
        })),
      "This chat is no longer in the active project. Switch back to this project and try again.",
    ],
    [
      "busy",
      (chat) => useIdeStore.getState().setChatSending(chat.id, true),
      "A message to this chat is still being sent.",
    ],
    [
      "host-away",
      (_chat, project) =>
        useIdeStore.setState({
          projects: [{ ...project, hostId: "ssh-box" }],
        }),
      "ssh-box is not connected. Send again once it is back.",
    ],
    [
      // The home host answers by the same rule (store/host-reach.ts).
      "host-away",
      () => connectionSupervisor.set(LOCAL_HOST_ID, "reconnecting"),
      "This host is not connected. Send again once it is back.",
    ],
    [
      "provider-unavailable",
      () =>
        useIdeStore.setState((state) => ({
          providerModels: {
            ...state.providerModels,
            anthropic: { ...state.providerModels.anthropic, installed: false },
          },
        })),
      "Anthropic CLI is not available. Check Settings > Providers.",
    ],
    [
      "no-model",
      () =>
        useIdeStore.setState((state) => ({
          settings: { ...state.settings, disabledProviders: ALL_PROVIDERS },
        })),
      "Enable at least one model in Settings first.",
    ],
  ];

  for (const [reason, arrange, message] of cases) {
    const { chat, project } = setUp();
    arrange(chat, project);
    requests = [];

    const result = await sendChatMessage(
      chat.id,
      { references: [], text: "Make this button blue" },
      { origin: "feedback" },
    );

    assert.deepEqual(result, { status: "refused", reason, message }, reason);
    // A busy chat's banner is the message being sent's.
    assert.equal(bannerOf(chat.id), reason === "busy" ? null : message, reason);
    assert.deepEqual(submits(), [], reason);
    // The sender let go of it, so it is back in the chat's draft.
    assert.equal(chatDrafts.get(chat.id).text, "Make this button blue", reason);
    stopRuntime();
    useIdeStore.setState(initialState, true);
  }
});

test("an empty message is refused without a word", async () => {
  const { chat } = setUp();

  const result = await sendChatMessage(
    chat.id,
    { files: [], references: [], text: "  " },
    { origin: "composer" },
  );

  assert.deepEqual(result, {
    status: "refused",
    reason: "empty",
    message: null,
  });
  assert.equal(bannerOf(chat.id), null);
  assert.deepEqual(submits(), []);
});

test("a refused composer message stays in the composer's draft as it was", async () => {
  const { chat } = setUp();
  useIdeStore.setState({ activeProjectId: "another-project" });
  chatDrafts.set(chat.id, { references: [], text: "Keep this" });

  const result = await sendChatMessage(
    chat.id,
    { files: [], references: [], text: "Keep this" },
    { origin: "composer" },
  );

  assert.equal(result.status, "refused");
  assert.equal(chatDrafts.get(chat.id).text, "Keep this");
});

test("a second message while the first is being sent is refused; a chat streaming here takes one", async () => {
  const { chat } = setUp();
  useIdeStore.setState({ streamingChatIds: { [chat.id]: true } });

  const first = sendChatMessage(
    chat.id,
    { references: [], text: "First" },
    { origin: "composer" },
  );
  assert.equal(useIdeStore.getState().sendingChatIds[chat.id], true);
  const second = await sendChatMessage(
    chat.id,
    { references: [], text: "Second" },
    { origin: "composer" },
  );

  assert.equal(second.status === "refused" && second.reason, "busy");
  assert.deepEqual(await first, { status: "sent" });
  assert.deepEqual(sentTexts(), ["First"]);

  // Once the host has the first, the next one goes, for the host to queue.
  assert.deepEqual(
    await sendChatMessage(
      chat.id,
      { references: [], text: "Second" },
      { origin: "composer" },
    ),
    { status: "sent" },
  );
  assert.deepEqual(sentTexts(), ["First", "Second"]);
});

test("a failed send answers its error and returns the text to the draft", async () => {
  const { chat } = setUp();
  const transport = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      String(url) === "/api/chat/submit"
        ? new Response("Cannot accept submission", { status: 400 })
        : transport(url, init),
    ),
  );

  const result: ChatSendResult = await sendChatMessage(
    chat.id,
    { references: [], text: "Review these lines" },
    { origin: "feedback" },
  );

  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /Cannot accept/);
  assert.match(bannerOf(chat.id) ?? "", /Cannot accept/);
  assert.equal(chatDrafts.get(chat.id).text, "Review these lines");
  assert.equal(useIdeStore.getState().sendingChatIds[chat.id], undefined);

  // The composer's draft is left as it was, not added to.
  chatDrafts.set(chat.id, { references: [], text: "Keep this draft" });
  const composed = await sendChatMessage(
    chat.id,
    { files: [], references: [], text: "Keep this draft" },
    { origin: "composer" },
  );
  assert.equal(composed.status, "failed");
  assert.equal(chatDrafts.get(chat.id).text, "Keep this draft");
});

test("a lost submit receipt retries the same durable request and attachment payload", async () => {
  const { chat } = setUp();
  const transport = globalThis.fetch;
  let attempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const response = await transport(url, init);
      if (String(url) === "/api/chat/submit" && ++attempts === 1)
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

  assert.deepEqual(
    await sendChatMessage(
      chat.id,
      { files: [file], references: [], text: "Use this context" },
      { origin: "composer" },
    ),
    { status: "sent" },
  );
  const sent = submits();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].body, sent[1].body);
  assert.deepEqual(
    (sent[0].body.message as { parts: unknown[] }).parts[0],
    file,
  );
});

test("store actions send through the same entry point", async () => {
  const { chat, project } = setUp();
  const promptId = useIdeStore
    .getState()
    .addSavedPrompt({ name: "Test", prompt: "Run the tests" }) as string;

  assert.deepEqual(
    await useIdeStore.getState().runSavedPrompt(project.id, promptId, chat.id),
    { status: "sent" },
  );
  assert.deepEqual(sentTexts(), ["Run the tests"]);
});
