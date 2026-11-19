import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { createTurnRegistry } from "../../../../electron/api/chat/turn-registry.js";
import { clearGeneratedGitText } from "../git-generated-text";
import { useIdeStore } from "../ide-store";
import {
  getChatSession,
  getChatSessionView,
  reattachChatStreams,
  respondToToolApproval,
  startChatRuntime,
} from "./chat-runtime";

const initialState = useIdeStore.getState();
let stopRuntime: () => void = () => {};

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
  useIdeStore.setState({
    activeProjectId: project.id,
    chats: [chat],
    messagesByChatId: { [chat.id]: [] },
    projects: [project],
    settings,
  });
  stopRuntime = startChatRuntime();
  return { chat };
};

const sse = (chunks: object[]) =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");

const question = (id: string) => [
  {
    type: "tool-input-start",
    toolCallId: id,
    toolName: "AskUserQuestion",
    dynamic: true,
    providerExecuted: true,
    toolMetadata: { kind: "question" },
  },
  {
    type: "tool-input-available",
    toolCallId: id,
    toolName: "AskUserQuestion",
    dynamic: true,
    providerExecuted: true,
    input: { questions: [{ question: `${id}?`, options: [] }] },
    toolMetadata: { kind: "question" },
  },
  {
    type: "tool-approval-request",
    toolCallId: id,
    approvalId: `anthropic:${id}`,
  },
];

const firstPart = [
  { type: "start", messageId: "assistant-1" },
  { type: "message-metadata", messageMetadata: { provider: "anthropic" } },
  { type: "start-step" },
  ...question("q1"),
];
const afterAnswer = [
  {
    type: "tool-output-available",
    toolCallId: "q1",
    output: "User answered",
    dynamic: true,
    providerExecuted: true,
  },
  { type: "reasoning-start", id: "r2" },
  { type: "reasoning-delta", id: "r2", delta: "Conflicting answers" },
  { type: "reasoning-end", id: "r2" },
  ...question("q2"),
];

afterEach(() => {
  stopRuntime();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useIdeStore.setState(initialState, true);
  clearGeneratedGitText();
});

const viewParts = (chatId: string) =>
  getChatSessionView(chatId)
    .messages.at(-1)
    ?.parts.map((part) =>
      "toolCallId" in part
        ? `${part.toolCallId}:${(part as { state: string }).state}`
        : part.type,
    );

/** Errors a body that delivers nothing for `ms`, as undici's bodyTimeout. */
const idleTimeout = (body: ReadableStream<Uint8Array>, ms: number) => {
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timer = null;
          finished = true;
          void reader.cancel();
          controller.error(new TypeError("network error"));
          resolve();
        }, ms);
        reader.read().then(
          ({ done, value }) => {
            if (finished) return;
            if (timer) clearTimeout(timer);
            if (done) controller.close();
            else controller.enqueue(value);
            resolve();
          },
          (error) => {
            if (finished) return;
            if (timer) clearTimeout(timer);
            controller.error(error);
            resolve();
          },
        );
      });
    },
    cancel(reason) {
      finished = true;
      if (timer) clearTimeout(timer);
      return reader.cancel(reason);
    },
  });
};

test.each([
  ["answered before the edge cuts the stream", 1_000, false],
  ["answered after the edge cut the stream", 400_000, false],
  ["answered after several cuts", 1_000_000, false],
  ["answered after a reattach", 1_000, true],
  ["answered after a cut and a reattach", 400_000, true],
])("a follow-up question shows (%s)", async (_name, wait, reattach) => {
  vi.useFakeTimers();
  const { chat } = setUp();
  const encoder = new TextEncoder();
  const registry = createTurnRegistry();
  let turnBody!: ReadableStreamDefaultController<Uint8Array>;
  await registry.start({
    chatId: chat.id,
    run: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            turnBody = controller;
            controller.enqueue(encoder.encode(sse(firstPart)));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  let streamRequests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const parsed = new URL(String(url), "http://localhost");
      const path = parsed.pathname;
      if (path === `/api/chat/${chat.id}/stream`) {
        streamRequests++;
        const from = Number(parsed.searchParams.get("from"));
        const resumed = registry.resume(chat.id, {
          from: Number.isSafeInteger(from) ? from : null,
          turnId: parsed.searchParams.get("turn"),
        });
        if (!resumed) return new Response(null, { status: 204 });
        return new Response(idleTimeout(resumed.body!, 300_000), {
          headers: resumed.headers,
          status: resumed.status,
        });
      }
      if (path === "/api/tool-approval-response")
        return Response.json({ handled: true });
      if (path === "/api/catalog/transcript") return Response.json([]);
      if (path === "/api/chat/queue")
        return Response.json({ paused: false, runs: [] });
      if (path === "/api/catalog")
        return Response.json({
          projects: [],
          chats: [],
          runningChatIds: [chat.id],
        });
      if (path === "/api/catalog/changes")
        return Response.json({
          projectIds: [],
          chatIds: [],
          conflicts: [],
          removedProjectIds: [],
          removedChatIds: [],
        });
      return new Response("{}", { status: 404 });
    }),
  );
  useIdeStore.setState({ hostRunningChatIds: { [chat.id]: true } });
  const session = getChatSession(chat.id);
  await vi.waitFor(() => assert.equal(session.chat.status, "streaming"));
  await vi.advanceTimersByTimeAsync(200);
  assert.deepEqual(viewParts(chat.id), ["step-start", "q1:approval-requested"]);

  await vi.advanceTimersByTimeAsync(wait);
  if (reattach) {
    reattachChatStreams("local");
    await vi.advanceTimersByTimeAsync(1_000);
  }
  console.log(
    `after ${wait}ms: ${streamRequests} stream requests, status ${session.chat.status}, streaming ${Boolean(useIdeStore.getState().streamingChatIds[chat.id])}`,
  );

  respondToToolApproval(chat.id, {
    approved: true,
    id: "anthropic:q1",
    reason: JSON.stringify({ answers: { "q1?": "Yes" } }),
  });
  await vi.advanceTimersByTimeAsync(10);
  turnBody.enqueue(encoder.encode(sse(afterAnswer)));
  await vi.advanceTimersByTimeAsync(200);
  assert.deepEqual(viewParts(chat.id), [
    "step-start",
    "q1:output-available",
    "reasoning",
    "q2:approval-requested",
  ]);
});
