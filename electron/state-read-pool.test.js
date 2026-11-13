// Reads on reader threads, beside the one writer.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { closePersistedStateDatabase } from "./persisted-state.js";
import { createStateReadPool } from "./state-read-pool.js";
import { createStateSaveQueue } from "./state-save-queue.js";

const open = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "dream-read-pool-"));
  const databasePath = path.join(directory, "state.db");
  const writer = createStateSaveQueue({ databasePath });
  const pool = createStateReadPool({
    databasePath,
    whenReady: () => writer.ready(),
  });
  const close = async () => {
    await pool.close();
    await writer.flushAndClose();
    closePersistedStateDatabase();
    await rm(directory, { force: true, maxRetries: 5, recursive: true });
  };
  return { close, pool, writer };
};

test("readers open the database the writer made, and see each settled write", async () => {
  const { close, pool, writer } = await open();
  try {
    // Before anything is written: the writer creates the file first.
    assert.deepEqual(await pool.read("catalog"), { chats: [], projects: [] });

    await writer.write("catalog-changes", {
      chats: [{ id: "c1", projectId: "p1", title: "Retry" }],
      projects: [{ id: "p1", path: "/work/p1" }],
    });
    const messages = [
      {
        id: "m1",
        parts: [{ text: "Raise the retry budget", type: "text" }],
        role: "user",
      },
    ];
    await writer.write("transcript", { chatId: "c1", messages });

    const [catalog, chat, transcript, search, projectPath] = await Promise.all([
      pool.read("catalog"),
      pool.read("chat", { chatId: "c1" }),
      pool.read("transcript-json", { chatId: "c1" }),
      pool.read("search", { query: "retry budget" }),
      pool.read("project-path", { chatId: "c1" }),
    ]);
    assert.deepEqual(
      catalog.chats.map((item) => [item.id, item.messageCount]),
      [["c1", 1]],
    );
    assert.equal(chat.title, "Retry");
    assert.equal(typeof transcript, "string");
    assert.deepEqual(JSON.parse(transcript), messages);
    assert.deepEqual(
      search.results.map((result) => result.chatId),
      ["c1"],
    );
    assert.equal(projectPath, "/work/p1");
  } finally {
    await close();
  }
});

test("a failed read is reported and the reader keeps serving; a closed pool refuses", async () => {
  const { close, pool } = await open();
  try {
    await assert.rejects(pool.read("no-such-read"), /Unknown read/);
    assert.equal(await pool.read("chat", { chatId: "none" }), null);

    await pool.close();
    await assert.rejects(pool.read("catalog"), /closed/);
  } finally {
    await close();
  }
});
