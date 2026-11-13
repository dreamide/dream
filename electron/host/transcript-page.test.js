import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  closePersistedStateDatabase,
  getPersistedStateDatabase,
  loadPersistedChatMessages,
} from "../persisted-state.js";
import { writeState } from "../state-writes.js";
import { readTranscriptPage } from "./transcript-page.js";

let directory;
afterEach(async () => {
  closePersistedStateDatabase();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const message = (n, text = `Message ${n}`) => ({
  id: `m-${n}`,
  role: n % 2 ? "assistant" : "user",
  parts: [{ type: "text", text }],
});
async function setup(messages) {
  directory = await mkdtemp(path.join(tmpdir(), "dream-pages-"));
  const options = { databasePath: path.join(directory, "state.db") };
  writeState(
    "catalog-changes",
    {
      projects: [{ id: "p", path: "/work", name: "p" }],
      chats: [
        { id: "c", projectId: "p", title: "c" },
        { id: "other", projectId: "p", title: "other" },
      ],
    },
    options,
  );
  writeState("transcript", { chatId: "c", messages }, options);
  return { db: getPersistedStateDatabase(options), options };
}

test("recent pages bound transfer and retain stable cursors through append and replacement", async () => {
  const messages = Array.from({ length: 2000 }, (_, index) =>
    message(index, "x".repeat(2048)),
  );
  const { db, options } = await setup(messages);
  const page = readTranscriptPage(db, { chatId: "c" });
  assert.equal(page.messages.length, 40);
  assert.equal(page.startIndex, 1960);
  assert.equal(page.total, 2000);
  const fullBytes = Buffer.byteLength(JSON.stringify(messages));
  const pageBytes = Buffer.byteLength(JSON.stringify(page));
  assert.ok(pageBytes < fullBytes * 0.021);
  console.info(
    `Transcript transfer fixture: ${fullBytes} bytes full, ${pageBytes} bytes recent page.`,
  );
  writeState(
    "transcript",
    { chatId: "c", fromIndex: 2000, messages: [message(2000)] },
    options,
  );
  const earlier = readTranscriptPage(db, { chatId: "c", before: page.before });
  assert.equal(earlier.messages.at(-1).id, "m-1959");
  assert.equal(earlier.total, 2001);
  assert.throws(
    () => readTranscriptPage(db, { chatId: "other", before: page.before }),
    /History changed/,
  );
  writeState(
    "transcript",
    { chatId: "c", messages: [message("replacement")] },
    options,
  );
  assert.throws(
    () => readTranscriptPage(db, { chatId: "c", before: page.before }),
    /History changed/,
  );
});

test("page byte budget keeps complete messages and paging reconstructs all history exactly once", async () => {
  const messages = Array.from({ length: 10 }, (_, index) =>
    message(index, "x".repeat(300_000)),
  );
  const { db } = await setup(messages);
  let before;
  let loaded = [];
  do {
    const page = readTranscriptPage(db, { chatId: "c", before });
    assert.ok(page.messages.length <= 3);
    loaded = [...page.messages, ...loaded];
    before = page.before;
  } while (before);
  assert.deepEqual(loaded, messages);
});

test("saving a loaded page preserves an unseen prefix and concurrently appended tail", async () => {
  const messages = Array.from({ length: 100 }, (_, index) => message(index));
  const { db, options } = await setup(messages);
  const page = readTranscriptPage(db, { chatId: "c" });
  const changed = page.messages.map((entry) =>
    entry.id === "m-99" ? message(99, "Answered") : entry,
  );
  writeState(
    "transcript",
    { chatId: "c", fromIndex: 100, messages: [message(100)] },
    options,
  );
  writeState(
    "transcript",
    { chatId: "c", messages: changed, mergeOnly: true },
    options,
  );
  const saved = loadPersistedChatMessages("c", options);
  assert.deepEqual(saved.slice(0, 60), messages.slice(0, 60));
  assert.equal(saved[99].parts[0].text, "Answered");
  assert.deepEqual(saved[100], message(100));
  assert.throws(
    () =>
      writeState(
        "transcript",
        { chatId: "c", messages: [message("missing")], mergeOnly: true },
        options,
      ),
    /History changed/,
  );
  assert.equal(loadPersistedChatMessages("c", options).length, 101);
});
