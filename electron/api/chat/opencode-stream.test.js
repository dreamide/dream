// The OpenCode Provider adapter, replayed: only the SDK's `createOpencode` is
// replaced, by a server whose client the test scripts. The adapter, the
// server module (providers/opencode-server.js) and the turn writer run as
// they do in the app.
import assert from "node:assert/strict";
import { createOpencode } from "@opencode-ai/sdk";
import { beforeEach, test, vi } from "vitest";
import { turnObservers } from "./agent-turn.js";
import { streamOpenCodeResponse } from "./opencode-stream.js";

vi.mock("@opencode-ai/sdk", () => ({ createOpencode: vi.fn() }));

const SESSION = "new-session";
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * A fake OpenCode server. `onPrompt(request, events)` plays the turn: it
 * pushes events and answers the prompt. `saved` is a session the server
 * still has, ending with `last`.
 */
const createFakeServer = ({ onPrompt, saved = null, last = null } = {}) => {
  const queue = [];
  let wake = () => {};
  let ended = false;
  const events = {
    push: (...pushed) => {
      queue.push(...pushed);
      wake();
    },
    /** The event stream ends as if OpenCode closed it. */
    end: () => {
      ended = true;
      wake();
    },
  };
  const calls = { create: [], prompt: [], replies: [] };
  const close = vi.fn();
  const client = {
    session: {
      get: async ({ path }) => ({
        data: path.id === saved ? { id: saved } : null,
      }),
      messages: async () => ({ data: last ? [{ info: last }] : [] }),
      create: async (request) => {
        calls.create.push(request);
        return { data: { id: SESSION } };
      },
      prompt: async (request) => {
        calls.prompt.push(request);
        return onPrompt(request, events);
      },
    },
    event: {
      subscribe: async ({ signal }) => ({
        stream: (async function* () {
          while (!signal.aborted) {
            if (queue.length > 0) {
              yield queue.shift();
              continue;
            }
            if (ended) return;
            await new Promise((resolve) => {
              wake = resolve;
              signal.addEventListener("abort", resolve, { once: true });
            });
          }
        })(),
      }),
    },
    postSessionIdPermissionsPermissionId: async (request) => {
      calls.replies.push(request);
      return { data: true };
    },
    mcp: { status: async () => ({ data: {} }) },
    config: { get: async () => ({ data: {} }) },
    tool: { ids: async () => ({ data: [] }) },
  };
  createOpencode.mockResolvedValue({ client, server: { close } });
  return { calls, close, events };
};

const assistantMessage = (id, sessionID = SESSION) => ({
  properties: { info: { id, role: "assistant", sessionID } },
  type: "message.updated",
});
const userMessage = (id, sessionID = SESSION) => ({
  properties: { info: { id, role: "user", sessionID } },
  type: "message.updated",
});
const textPart = (id, messageID, text, delta, sessionID = SESSION) => ({
  properties: {
    ...(delta === undefined ? {} : { delta }),
    part: { id, messageID, sessionID, text, type: "text" },
  },
  type: "message.part.updated",
});

/** Answers the prompt once the events pushed for it have been read. */
const answer = async (events, ...pushed) => {
  events.push(...pushed);
  await flush();
  return { data: { info: {}, parts: [] } };
};

const request = {
  messages: [
    { id: "u1", parts: [{ text: "Hello", type: "text" }], role: "user" },
  ],
  model: "opencode-go/kimi-k2.6",
  permissionMode: "ask",
  projectPath: "/work",
};
const followUp = [
  ...request.messages,
  { id: "a1", parts: [{ text: "Hi", type: "text" }], role: "assistant" },
  { id: "u2", parts: [{ text: "Next step", type: "text" }], role: "user" },
];

/** Runs a turn under a host observer, as a host runs one. */
const run = async (options, signal) => {
  const starts = [];
  const observer = {
    onMessage: () => {},
    onSessionStart: (start) => {
      starts.push(start);
      return {};
    },
  };
  const response = await turnObservers.run(observer, () =>
    streamOpenCodeResponse({ ...request, ...options, abortSignal: signal }),
  );
  const chunks = (await response.text())
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
  return { chunks, starts };
};

const textOf = (chunks) =>
  chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => chunk.delta)
    .join("");
const errorOf = (chunks) =>
  chunks.find((chunk) => chunk.type === "error")?.errorText;

beforeEach(() => vi.clearAllMocks());

test("a fresh turn streams the answer, drops the echoed prompt, and closes its server", async () => {
  const { calls, close } = createFakeServer({
    onPrompt: (_prompt, events) =>
      answer(
        events,
        // The user's own message is echoed back: not part of the answer.
        userMessage("m-user"),
        textPart("p-user", "m-user", "Hello"),
        // A part can arrive before the message saying whose it is.
        textPart("p1", "m-answer", "Hi", "Hi"),
        assistantMessage("m-answer"),
        textPart("p1", "m-answer", "Hi there", " there"),
      ),
  });

  const { chunks, starts } = await run({});
  assert.equal(errorOf(chunks), undefined);
  assert.equal(textOf(chunks), "Hi there");
  assert.deepEqual(starts, [{ resumed: false }]);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].body.agent, "build");
  assert.deepEqual(calls.create[0].body.model, {
    id: "kimi-k2.6",
    providerID: "opencode-go",
  });
  assert.equal(calls.prompt[0].path.id, SESSION);
  assert.equal(close.mock.calls.length, 1);
});

test("a healthy saved session is resumed with only the latest prompt and the handoff", async () => {
  const { calls, close } = createFakeServer({
    last: { finish: "stop", role: "assistant", time: { completed: 1 } },
    onPrompt: (_prompt, events) =>
      answer(
        events,
        assistantMessage("m2", "saved"),
        textPart("p2", "m2", "Done", "Done", "saved"),
      ),
    saved: "saved",
  });

  const { chunks, starts } = await run({
    messages: followUp,
    resumeSessionId: "saved",
    sessionHandoff: "Missed while away.",
  });
  assert.equal(textOf(chunks), "Done");
  assert.deepEqual(starts, [{ resumed: true }]);
  assert.equal(calls.create.length, 0);
  const prompt = calls.prompt[0];
  assert.equal(prompt.path.id, "saved");
  const text = prompt.body.parts.map((part) => part.text).join("");
  assert.match(text, /Next step/);
  assert.match(text, /Missed while away\./);
  assert.doesNotMatch(text, /Conversation transcript/);
  // Tools a previous turn hid are cleared on the resumed session.
  assert.deepEqual(prompt.body.tools, { "dream-tool-budget-reset": false });
  assert.equal(close.mock.calls.length, 1);
});

test("an unhealthy saved session is replaced, says why, and gets the full history without the handoff", async () => {
  const { calls } = createFakeServer({
    last: { finish: "tool-calls", role: "assistant", time: { completed: 1 } },
    onPrompt: (_prompt, events) =>
      answer(
        events,
        assistantMessage("m2"),
        textPart("p2", "m2", "Again", "Again"),
      ),
    saved: "saved",
  });

  const { starts } = await run({
    messages: followUp,
    resumeSessionId: "saved",
    sessionHandoff: "Missed while away.",
  });
  assert.deepEqual(starts, [
    {
      reason: "OpenCode's saved session ended unfinished or with an error.",
      resumed: false,
    },
  ]);
  assert.equal(calls.create.length, 1);
  const text = calls.prompt[0].body.parts.map((part) => part.text).join("");
  assert.match(text, /Hello/);
  assert.doesNotMatch(text, /Missed while away\./);
  assert.equal(calls.prompt[0].body.tools, undefined);
});

test("a session error ends the turn with its detail, and the server closes", async () => {
  const { close } = createFakeServer({
    onPrompt: async (_prompt, events) => {
      events.push({
        properties: { error: "Model quota exceeded.", sessionID: SESSION },
        type: "session.error",
      });
      // The prompt never answers: the error ends the turn.
      return new Promise(() => {});
    },
  });

  const { chunks } = await run({});
  assert.match(errorOf(chunks), /Model quota exceeded\./);
  assert.equal(close.mock.calls.length, 1);
});

test("an event stream that closes before the turn completes is an error", async () => {
  createFakeServer({
    onPrompt: async (_prompt, events) => {
      events.end();
      return new Promise(() => {});
    },
  });

  const { chunks } = await run({});
  assert.match(
    errorOf(chunks),
    /event stream closed before the turn completed/,
  );
});

test("Stop ends the turn without an error, and the server closes", async () => {
  const controller = new AbortController();
  const { close } = createFakeServer({
    onPrompt: async (_prompt, events) => {
      events.push(
        assistantMessage("m1"),
        textPart("p1", "m1", "Working", "Working"),
      );
      await flush();
      controller.abort();
      return new Promise(() => {});
    },
  });

  const { chunks } = await run({}, controller.signal);
  assert.equal(errorOf(chunks), undefined);
  assert.equal(textOf(chunks), "Working");
  assert.equal(close.mock.calls.length, 1);
});

test("with full access, OpenCode's permission requests are answered without asking", async () => {
  const { calls } = createFakeServer({
    onPrompt: (_prompt, events) =>
      answer(
        events,
        {
          properties: {
            id: "perm-1",
            sessionID: SESSION,
            title: "Run tests",
            type: "bash",
          },
          type: "permission.updated",
        },
        assistantMessage("m1"),
        textPart("p1", "m1", "Ran them", "Ran them"),
      ),
  });

  const { chunks } = await run({ permissionMode: "full-access" });
  assert.equal(textOf(chunks), "Ran them");
  assert.deepEqual(calls.replies, [
    {
      body: { response: "once" },
      path: { id: SESSION, permissionID: "perm-1" },
      query: { directory: "/work" },
    },
  ]);
});
