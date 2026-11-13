// The OpenCode server for one unit of work, through its interface. Only the
// SDK's `createOpencode` is replaced: a server whose client the test scripts.
import assert from "node:assert/strict";
import { createOpencode } from "@opencode-ai/sdk";
import { beforeEach, test, vi } from "vitest";
import {
  createOpenCodeSession,
  OPENCODE_SERVER_TIMEOUT_MS,
  openOpenCodeServer,
  resumeOpenCodeSession,
  withOpenCodeServer,
} from "./opencode-server.js";

vi.mock("@opencode-ai/sdk", () => ({ createOpencode: vi.fn() }));

let close;
beforeEach(() => {
  vi.clearAllMocks();
  close = vi.fn();
  createOpencode.mockResolvedValue({ client: {}, server: { close } });
});

/** A client whose saved session `saved` ends with `last`, when there is one. */
const clientWith = ({ saved = "s1", last } = {}) => ({
  session: {
    get: vi.fn(async ({ path }) => ({
      data: path.id === saved ? { id: saved } : null,
    })),
    messages: vi.fn(async () => ({ data: last ? [{ info: last }] : [] })),
  },
});

const finished = {
  finish: "stop",
  role: "assistant",
  time: { completed: 1 },
};

test("a server starts on a free loopback port and closes once", async () => {
  const signal = new AbortController().signal;
  const server = await openOpenCodeServer({ config: { a: 1 }, signal });
  assert.deepEqual(createOpencode.mock.calls[0][0], {
    config: { a: 1 },
    hostname: "127.0.0.1",
    port: 0,
    signal,
    timeout: OPENCODE_SERVER_TIMEOUT_MS,
  });
  server.close();
  server.close();
  assert.equal(close.mock.calls.length, 1);
});

test("work run with a server closes it however the work ends", async () => {
  assert.equal(await withOpenCodeServer({}, async () => "done"), "done");
  assert.equal(close.mock.calls.length, 1);

  await assert.rejects(
    withOpenCodeServer({ timeoutMs: 5 }, async () => {
      throw new Error("prompt failed");
    }),
    /prompt failed/,
  );
  assert.equal(close.mock.calls.length, 2);
  assert.equal(createOpencode.mock.calls[1][0].timeout, 5);

  // A server that never started has nothing to close.
  createOpencode.mockRejectedValueOnce(new Error("Timeout waiting for server"));
  await assert.rejects(
    withOpenCodeServer({}, async () => {}),
    /Timeout/,
  );
  assert.equal(close.mock.calls.length, 2);
});

test("only a session whose last message is a finished, error-free answer is resumed", async () => {
  const resume = (client) =>
    resumeOpenCodeSession(client, { directory: "/work", sessionId: "s1" });

  assert.deepEqual(await resume(clientWith({ last: finished })), {
    resumed: true,
  });
  for (const last of [
    undefined,
    { ...finished, role: "user" },
    { ...finished, error: { name: "APIError" } },
    { ...finished, time: {} },
    { ...finished, finish: undefined },
    { ...finished, finish: "tool-calls" },
  ]) {
    assert.deepEqual(await resume(clientWith({ last })), {
      reason: "OpenCode's saved session ended unfinished or with an error.",
      resumed: false,
    });
  }

  const gone = clientWith({ last: finished, saved: "other" });
  assert.deepEqual(await resume(gone), {
    reason: "OpenCode no longer has the saved session.",
    resumed: false,
  });
  assert.equal(gone.session.messages.mock.calls.length, 0);
});

test("a session is created for its agent and model, and a missing id is an error", async () => {
  const signal = new AbortController().signal;
  const create = vi.fn(async () => ({ data: { id: "new" } }));
  const client = { session: { create } };
  const model = { modelID: "kimi", providerID: "opencode-go" };
  assert.equal(
    await createOpenCodeSession(client, {
      agent: "plan",
      directory: "/work",
      model,
      signal,
    }),
    "new",
  );
  assert.deepEqual(create.mock.calls[0][0], {
    body: { agent: "plan", model: { id: "kimi", providerID: "opencode-go" } },
    query: { directory: "/work" },
    signal,
  });

  create.mockResolvedValueOnce({ data: null });
  await assert.rejects(
    createOpenCodeSession(client, { agent: "plan", directory: "/w", model }),
    /did not return a session id/,
  );
});
