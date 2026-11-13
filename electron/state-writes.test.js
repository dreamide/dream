// The write table, through its interface: every write runs whole or not at
// all, an unknown write is refused before it reaches the database, the host's
// writes all have a row, and queued writes apply in order.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { readProviderSession } from "./host/provider-session-store.js";
import {
  closePersistedStateDatabase,
  getPersistedStateDatabase,
  loadPersistedChatMessages,
} from "./persisted-state.js";
import { createStateSaveQueue } from "./state-save-queue.js";
import {
  createInThreadStateWriter,
  findStateWrite,
  runStateWrite,
  stateWrites,
  writeState,
} from "./state-writes.js";

let directory = null;
afterEach(async () => {
  closePersistedStateDatabase();
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = null;
});

const setup = async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dream-state-writes-"));
  const options = { databasePath: path.join(directory, "state.db") };
  writeState(
    "catalog-changes",
    {
      chats: [{ id: "c", projectId: "p", title: "c" }],
      projects: [{ id: "p", name: "p", path: "/work" }],
    },
    options,
  );
  return options;
};

const message = (id, text = id) => ({
  id,
  parts: [{ text, type: "text" }],
  role: "user",
});

test("the names the host writes by each have a row", () => {
  // host/catalog.js, host/auth/host-auth.js and the desktop's own writes.
  for (const name of [
    "catalog-changes",
    "transcript",
    "run-queue",
    "provider-session",
    "device-session",
    "workspace-changes",
    "config",
  ])
    assert.ok(findStateWrite(name), name);
  assert.equal(findStateWrite("toString"), null);
  assert.equal(findStateWrite(undefined), null);
});

test("a write that fails leaves nothing behind", async () => {
  const options = await setup();
  const database = getPersistedStateDatabase(options);
  writeState("transcript", { chatId: "c", messages: [message("a")] }, options);

  // A merge-only save names a message the transcript no longer has: it is
  // refused, and the transcript is as it was.
  assert.throws(
    () =>
      runStateWrite(database, "transcript", {
        chatId: "c",
        mergeOnly: true,
        messages: [message("a", "edited"), message("gone")],
      }),
    /History changed before saving/,
  );
  assert.deepEqual(
    loadPersistedChatMessages("c", options).map((saved) => saved.parts),
    [[{ text: "a", type: "text" }]],
  );

  // The transaction is over either way: the next write goes through.
  writeState(
    "provider-session",
    { chatId: "c", provider: "openai", session: { remoteConversationId: "s" } },
    options,
  );
  assert.equal(
    readProviderSession(database, { chatId: "c", provider: "openai" })
      .remoteConversationId,
    "s",
  );
});

test("a write's own failure rolls back what it wrote before failing", async () => {
  const options = await setup();
  const database = getPersistedStateDatabase(options);
  // A write that changes a row and then throws, as a partial one would.
  stateWrites["test-partial"] = {
    run: (db) => {
      db.prepare("UPDATE chats SET title = 'changed' WHERE id = 'c'").run();
      throw new Error("failed halfway");
    },
  };
  try {
    assert.throws(
      () => runStateWrite(database, "test-partial", null),
      /failed halfway/,
    );
  } finally {
    delete stateWrites["test-partial"];
  }
  assert.equal(
    database.prepare("SELECT title FROM chats WHERE id = 'c'").get().title,
    "c",
  );
});

test("an unknown write is refused before it reaches the database", async () => {
  const options = await setup();
  assert.throws(
    () => runStateWrite(getPersistedStateDatabase(options), "nope", {}),
    /Unknown state write: nope/,
  );
  const queue = createStateSaveQueue(options);
  try {
    await assert.rejects(queue.write("nope", {}), /Unknown state write: nope/);
  } finally {
    await queue.flushAndClose();
  }
});

test("queued writes apply in order, and a merged transcript save says what the two did", async () => {
  const options = await setup();
  closePersistedStateDatabase();
  const queue = createStateSaveQueue(options);
  try {
    // Two catalog changes in a row are deltas: both apply, in order.
    const renamed = queue.write("catalog-changes", {
      chats: [{ id: "c", projectId: "p", title: "first" }],
    });
    const renamedAgain = queue.write("catalog-changes", {
      chats: [{ id: "c", projectId: "p", title: "second" }],
    });
    // Two saves of one transcript, which the queue may merge into one (the
    // rule: mergeTranscriptSaves, state-save-queue.test.js); merged or not,
    // the later wins from its own start.
    const first = queue.write("transcript", {
      chatId: "c",
      messages: [message("a"), message("b")],
    });
    const second = queue.write("transcript", {
      chatId: "c",
      fromIndex: 1,
      messages: [message("b2")],
    });
    await Promise.all([renamed, renamedAgain, first, second]);
    await queue.settled();
  } finally {
    await queue.flushAndClose();
  }
  const database = getPersistedStateDatabase(options);
  assert.equal(
    database.prepare("SELECT title FROM chats WHERE id = 'c'").get().title,
    "second",
  );
  assert.deepEqual(
    loadPersistedChatMessages("c", options).map((saved) => saved.id),
    ["a", "b2"],
  );
});

test("the in-thread writer is a state writer: the same writes, at once", async () => {
  const options = await setup();
  const writer = createInThreadStateWriter(options);
  await writer.ready();
  await writer.write("transcript", { chatId: "c", messages: [message("x")] });
  await writer.settled();
  assert.deepEqual(
    loadPersistedChatMessages("c", options).map((saved) => saved.id),
    ["x"],
  );
  await assert.rejects(writer.write("nope", {}), /Unknown state write/);
});
