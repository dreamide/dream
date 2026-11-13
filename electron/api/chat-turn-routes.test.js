// Turns on the host, over the chat routes: they outlive their client, can be
// followed again from the start, run one at a time per chat, stop only when
// told, and are saved to the catalog as they run.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, test, vi } from "vitest";

const gate = vi.hoisted(() => ({ release: null, signal: null }));

vi.mock("./providers/registry.js", async () => {
  const { streamAgentTurn } = await import("./chat/agent-turn.js");
  return {
    getProvider: () => ({
      id: "openai",
      browserMcpScope: null,
      checkReady: async () => null,
      stream: ({ abortSignal, messages, responseMessageMetadata }) =>
        streamAgentTurn({
          abortSignal,
          execute: async (turn) => {
            gate.signal = abortSignal;
            turn.text("Working", "t1");
            turn.endText("t1");
            await new Promise((resolve) => {
              gate.release = resolve;
              abortSignal?.addEventListener("abort", resolve, { once: true });
            });
            turn.session("session-42");
            turn.text(" done.", "t2");
          },
          label: "Test",
          messages,
          model: "m",
          projectPath: "/p",
          provider: "openai",
          responseMessageMetadata,
        }),
    }),
  };
});

const { createTurnRegistry } = await import("./chat/turn-registry.js");
const { registerChatRoutes } = await import("./chat-routes.js");
const { createHostCatalog } = await import("../host/catalog.js");
const { configureHostDataDirectory } = await import("../host/host-paths.js");
const persisted = await import("../persisted-state.js");
const { createInThreadStateWriter } = await import("../state-writes.js");

let directory = null;
let turns = null;
// Writes the host started; a turn's last ones land after it stops running.
const pendingWrites = new Set();
const trackWrite = (write) => {
  const promise = Promise.resolve().then(write);
  pendingWrites.add(promise);
  promise.then(
    () => pendingWrites.delete(promise),
    () => pendingWrites.delete(promise),
  );
  return promise;
};

// Settled: no write pending across a whole turn of the event loop. The host
// observer's last steps (the final save, then the chat read and the session
// change) each start when the one before settles, a few microtasks later,
// so a check made between two of them would see none pending.
const writesSettled = async () => {
  if (pendingWrites.size > 0) return false;
  await new Promise((resolve) => setImmediate(resolve));
  return pendingWrites.size === 0;
};

afterEach(async () => {
  gate.release?.();
  gate.release = null;
  gate.signal = null;
  // A write after the database closes would reopen it and keep it locked.
  if (turns) await waitFor(() => !turns.isRunning("c1"));
  await waitFor(writesSettled);
  turns = null;
  persisted.closePersistedStateDatabase();
  // Windows can hold the database file for a moment after it is closed.
  if (directory) {
    await rm(directory, { force: true, maxRetries: 5, recursive: true });
  }
  directory = null;
});

const setup = async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dream-turns-"));
  configureHostDataDirectory(directory);
  const events = [];
  const saves = [];
  const writer = createInThreadStateWriter();
  const catalog = createHostCatalog({
    events: { publish: (event) => events.push(event) },
    // The same writes as the save queue, in this thread, each one tracked.
    getWriter: () => ({
      ...writer,
      write: (name, payload) => {
        if (name === "transcript") saves.push(payload);
        return trackWrite(() => writer.write(name, payload));
      },
    }),
  });
  await catalog.applyChanges({
    chats: [{ id: "c1", projectId: "p1", title: "Chat" }],
    projects: [{ id: "p1", path: directory }],
  });
  turns = createTurnRegistry();
  const app = new Hono();
  registerChatRoutes(app, { catalog, turns });

  const startTurn = (
    messages = [
      { id: "u1", parts: [{ text: "Go", type: "text" }], role: "user" },
    ],
  ) =>
    app.request("/api/chat", {
      body: JSON.stringify({
        chatId: "c1",
        checkpointsEnabled: false,
        messages,
        model: "m",
        projectPath: directory,
        provider: "openai",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
  return { app, catalog, events, saves, startTurn, turns };
};

const transcriptOf = async (catalog, chatId) =>
  JSON.parse(await catalog.getTranscriptJson(chatId));

const waitFor = async (check) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting.");
};

test("a turn outlives its client and is saved, provider session included", async () => {
  const { catalog, startTurn, turns } = await setup();

  const response = await startTurn();
  assert.equal(response.status, 200);
  // The client goes away mid-turn.
  await response.body.cancel();
  await waitFor(() => gate.release !== null);
  gate.release();
  await waitFor(() => !turns.isRunning("c1"));

  // Saved by the host, the client's own request first.
  await waitFor(async () => {
    const transcript = await transcriptOf(catalog, "c1");
    return transcript.length === 2 && transcript[1].role === "assistant";
  });
  const [user, assistant] = await transcriptOf(catalog, "c1");
  assert.equal(user.id, "u1");
  assert.match(
    assistant.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    /Working done\./,
  );
  await waitFor(
    async () =>
      (await catalog.getChat("c1"))?.remoteConversationId === "session-42",
  );
});

test("a reconnecting client follows the running turn from its start", async () => {
  const { app, startTurn } = await setup();
  const response = await startTurn();
  await response.body.cancel();
  await waitFor(() => gate.release !== null);

  const resumed = await app.request("/api/chat/c1/stream");
  gate.release();
  const text = await resumed.text();

  assert.equal(resumed.status, 200);
  assert.match(text, /Working/);
  assert.match(text, /done\./);
  assert.equal((await app.request("/api/chat/c1/stream")).status, 204);
});

test("a second turn in the same chat is refused while one runs", async () => {
  const { startTurn } = await setup();
  const first = await startTurn();
  await waitFor(() => gate.release !== null);

  const second = await startTurn();

  assert.equal(second.status, 409);
  gate.release();
  await first.text();
});

test("only the stop route ends a turn early", async () => {
  const { app, startTurn, turns } = await setup();
  const response = await startTurn();
  await response.body.cancel();
  await waitFor(() => gate.signal !== null);
  assert.equal(gate.signal.aborted, false);

  const stopped = await app.request("/api/chat/stop", {
    body: JSON.stringify({ chatId: "c1" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  assert.deepEqual(await stopped.json(), { stopped: true });
  assert.equal(gate.signal.aborted, true);
  await waitFor(() => !turns.isRunning("c1"));
});

test("a running turn is saved as it goes, the request once, then only the message it is writing", async () => {
  const { catalog, events, saves, startTurn, turns } = await setup();
  const request = [
    { id: "u1", parts: [{ text: "Hi", type: "text" }], role: "user" },
    { id: "a1", parts: [{ text: "Hello", type: "text" }], role: "assistant" },
    { id: "u2", parts: [{ text: "Go", type: "text" }], role: "user" },
  ];
  const assistantText = async () =>
    (await transcriptOf(catalog, "c1"))
      .at(-1)
      ?.parts.filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");

  const response = await startTurn(request);
  await response.body.cancel();
  // The test provider marks no steps; what it wrote is saved while it waits.
  await waitFor(async () => (await assistantText()) === "Working");
  assert.equal(turns.isRunning("c1"), true);

  gate.release();
  await waitFor(() => !turns.isRunning("c1"));
  await waitFor(async () => (await assistantText()) === "Working done.");

  assert.ok(saves.length > 1);
  const [first, ...rest] = saves;
  assert.equal(first.fromIndex ?? 0, 0);
  assert.deepEqual(
    first.messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
  for (const save of rest) {
    assert.equal(save.fromIndex, 3);
    assert.equal(save.messages.length, 1);
    assert.equal(save.messages[0].role, "assistant");
  }
  assert.ok(rest.at(-1).messages[0].metadata.completedAt);

  assert.deepEqual(
    (await transcriptOf(catalog, "c1"))
      .map((message) => message.id)
      .slice(0, 3),
    ["u1", "a1", "u2"],
  );
  // Clients are told the whole transcript's length either way.
  assert.ok(
    events
      .filter((event) => event.kind === "transcript")
      .every((event) => event.messageCount === 4),
  );
});
