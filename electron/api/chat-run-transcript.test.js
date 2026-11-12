// A Chat run prepares its transcript once: the submission is saved as one row,
// the turn then writes only its own message, and the provider session it
// leaves behind resumes the next run (the fingerprints agree).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";

const seen = vi.hoisted(() => ({ sessions: [] }));

vi.mock("./providers/registry.js", async () => {
  const { streamAgentTurn } = await import("./chat/agent-turn.js");
  return {
    getProvider: () => ({
      browserMcpScope: null,
      checkReady: async () => null,
      stream: ({
        abortSignal,
        messages,
        projectPath,
        remoteConversationId,
        responseMessageMetadata,
      }) => {
        seen.sessions.push(remoteConversationId ?? null);
        return streamAgentTurn({
          abortSignal,
          execute: async (turn) => {
            turn.session("session-1");
            turn.text(`answer ${messages.length}`, "t");
            turn.endText("t");
          },
          label: "Test",
          messages,
          model: "m",
          projectPath,
          provider: "openai",
          responseMessageMetadata,
        });
      },
    }),
  };
});

const { createHostCatalog } = await import("../host/catalog.js");
const { createStateReadPool } = await import("../state-read-pool.js");
const { createStateSaveQueue } = await import("../state-save-queue.js");
const { createRunScheduler } = await import("./chat/run-scheduler.js");
const { transcriptFingerprint } = await import("./chat/session-context.js");
const { createTurnRegistry } = await import("./chat/turn-registry.js");
const { executeChatRequest } = await import("./chat-routes.js");

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  seen.sessions = [];
});

const until = async (read, predicate) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Queue did not settle.");
};

test("a Chat run saves its submission once, then only the assistant row, and resumes the next run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dream-run-turn-"));
  cleanups.push(() =>
    rm(directory, { force: true, maxRetries: 5, recursive: true }),
  );
  const databasePath = path.join(directory, "state.db");
  const writer = createStateSaveQueue({ databasePath });
  cleanups.push(() => writer.flushAndClose());
  const reader = createStateReadPool({ databasePath, whenReady: writer.ready });
  cleanups.push(() => reader.close());
  const saves = [];
  const catalog = createHostCatalog({
    events: { publish() {} },
    getWriter: () => ({
      ...writer,
      saveChatMessages: (payload) => {
        saves.push(payload);
        return writer.saveChatMessages(payload);
      },
    }),
    getReader: () => reader,
  });
  await catalog.applyChanges({
    projects: [{ id: "p", path: directory, name: "p" }],
    chats: [{ id: "c", projectId: "p", title: "c" }],
  });
  const scheduler = createRunScheduler({
    catalog,
    turns: createTurnRegistry(),
    execute: executeChatRequest,
  });
  cleanups.push(() => scheduler.close());
  const submit = (id) =>
    scheduler.submit({
      requestId: id,
      chatId: "c",
      checkpointsEnabled: false,
      provider: "openai",
      model: "m",
      projectPath: directory,
      message: { id, role: "user", parts: [{ type: "text", text: id }] },
    });
  const transcript = async () =>
    JSON.parse(await catalog.getTranscriptJson("c"));

  await submit("one");
  await submit("two");
  await until(
    () => scheduler.list("c"),
    (queue) =>
      queue.runs.length === 2 &&
      queue.runs.every((run) => run.status === "completed"),
  );
  const saved = await until(transcript, (rows) => rows.length === 4);
  assert.deepEqual(
    saved.map((row) => row.role),
    ["user", "assistant", "user", "assistant"],
  );

  // No save carries more than one row, and each run's first is its submission.
  for (const save of saves) assert.equal(save.messages.length, 1);
  const submissions = saves.filter((save) => save.messages[0].role === "user");
  assert.deepEqual(
    submissions.map((save) => [save.fromIndex, save.messages[0].id]),
    [
      [0, "one"],
      [2, "two"],
    ],
  );
  for (const save of saves.filter((save) => save.messages[0].role !== "user"))
    assert.ok(save.fromIndex === 1 || save.fromIndex === 3);

  // The first run's session matched the transcript it left, so the second
  // resumed it.
  assert.deepEqual(seen.sessions, [null, "session-1"]);
  const session = await catalog.providerSession("c", "openai");
  assert.equal(session.lastMessageId, saved[3].id);
  assert.equal(session.fingerprint, transcriptFingerprint(saved));
});
