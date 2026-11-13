// The host catalog's rows: granular changes that touch only what they name.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";
import {
  closePersistedStateDatabase,
  loadPersistedCatalog,
  loadPersistedChatMessages,
  searchPersistedChatMessages,
} from "../persisted-state.js";
import { writeState } from "../state-writes.js";
import { loadChatMessagesJson, saveChatMessages } from "./catalog-store.js";

let directory = null;
afterEach(async () => {
  closePersistedStateDatabase();
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = null;
});

const open = async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dream-catalog-test-"));
  const databasePath = path.join(directory, "state.db");
  return {
    apply: (changes) =>
      writeState("catalog-changes", changes, { databasePath }),
    catalog: () => loadPersistedCatalog({ databasePath }),
    messages: (chatId) => loadPersistedChatMessages(chatId, { databasePath }),
    databasePath,
    saveMessages: (chatId, messages, fromIndex) =>
      writeState(
        "transcript",
        { chatId, fromIndex, messages },
        { databasePath },
      ),
    search: (query, options) =>
      searchPersistedChatMessages(query, { ...options, databasePath }),
  };
};

const project = (id, projectPath = `/work/${id}`) => ({
  id,
  name: id,
  path: projectPath,
  runCommand: "pnpm dev",
  ui: { multiChat: true },
});
const chat = (id, projectId, title = id) => ({
  id,
  projectId,
  title,
});

test("a change touches only the projects and chats it names", async () => {
  const db = await open();
  db.apply({
    chats: [chat("c1", "a"), chat("c2", "b")],
    projects: [project("a"), project("b")],
  });

  // Another client renames one chat; nothing else is said, nothing else goes.
  db.apply({ chats: [chat("c1", "a", "Renamed")] });

  const { chats, projects } = db.catalog();
  assert.deepEqual(
    projects.map((item) => item.id),
    ["a", "b"],
  );
  assert.deepEqual(
    chats.map((item) => [item.id, item.title]),
    [
      ["c1", "Renamed"],
      ["c2", "c2"],
    ],
  );
});

test("the catalog keeps no workspace fields", async () => {
  const db = await open();
  db.apply({ projects: [{ ...project("a"), lastUsedAt: "2026-01-01" }] });

  const [stored] = db.catalog().projects;
  assert.equal(stored.ui, undefined);
  assert.equal(stored.lastUsedAt, null);
});

test("a path belongs to one project; a second claim is a conflict", async () => {
  const db = await open();
  db.apply({ projects: [project("a", "/work/shared")] });

  const result = db.apply({ projects: [project("b", "/work/shared")] });

  assert.deepEqual(result.conflicts, [
    { existingId: "a", id: "b", path: "/work/shared" },
  ]);
  assert.deepEqual(
    db.catalog().projects.map((item) => item.id),
    ["a"],
  );
});

test("a chat can move to a project added in the same change", async () => {
  const db = await open();
  db.apply({ chats: [chat("c1", "a")], projects: [project("a")] });
  db.saveMessages("c1", [{ id: "m1", parts: [], role: "user" }]);

  db.apply({ chats: [chat("c1", "b")], projects: [project("b")] });

  assert.equal(db.catalog().chats[0].projectId, "b");
  assert.equal(db.messages("c1").length, 1);
});

test("removing a project removes its chats and transcripts", async () => {
  const db = await open();
  db.apply({
    chats: [chat("c1", "a"), chat("c2", "b")],
    projects: [project("a"), project("b")],
  });
  db.saveMessages("c1", [{ id: "m1", parts: [], role: "user" }]);

  const result = db.apply({ removedChatIds: ["c2"], removedProjectIds: ["a"] });

  assert.deepEqual(result.removedProjectIds, ["a"]);
  assert.deepEqual(db.catalog().chats, []);
  assert.deepEqual(db.messages("c1"), []);
});

test("a transcript is saved only for a chat the catalog has", async () => {
  const db = await open();
  db.apply({ chats: [chat("c1", "a")], projects: [project("a")] });

  assert.equal(
    db.saveMessages("c1", [
      { id: "m1", parts: [], role: "user" },
      { id: "m2", parts: [], role: "assistant" },
    ]),
    true,
  );
  assert.equal(db.saveMessages("missing", []), false);
  assert.equal(db.catalog().chats[0].messageCount, 2);
});

test("saving a transcript again writes only the rows that changed", async () => {
  const db = await open();
  db.apply({ chats: [chat("c1", "a")], projects: [project("a")] });
  const first = [
    { id: "m1", parts: [{ text: "Go", type: "text" }], role: "user" },
    { id: "m2", parts: [{ text: "On", type: "text" }], role: "assistant" },
    { id: "m3", parts: [{ text: "More", type: "text" }], role: "user" },
  ];
  db.saveMessages("c1", first);
  closePersistedStateDatabase();

  // The same store function on a handle that counts what it writes.
  const database = new DatabaseSync(db.databasePath);
  const writes = [];
  const counting = {
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        all: (...values) => statement.all(...values),
        get: (...values) => statement.get(...values),
        run: (...values) => {
          writes.push(sql.trim().split(/\s+/)[0]);
          return statement.run(...values);
        },
      };
    },
  };
  try {
    const next = [
      first[0],
      first[1],
      { ...first[2], parts: [{ text: "More, please", type: "text" }] },
      { id: "m4", parts: [], role: "assistant" },
    ];
    saveChatMessages(counting, "c1", next, new Date().toISOString());
    // The changed message and its search text; the new one, which has no
    // text, alone.
    assert.deepEqual(writes, ["INSERT", "INSERT", "INSERT"]);

    writes.length = 0;
    saveChatMessages(counting, "c1", next, new Date().toISOString());
    assert.deepEqual(writes, []);
  } finally {
    database.close();
  }

  assert.deepEqual(
    db.messages("c1").map((item) => item.id),
    ["m1", "m2", "m3", "m4"],
  );
  assert.equal(db.messages("c1")[2].parts[0].text, "More, please");
});

test("a transcript saved from an index keeps what came before it", async () => {
  const db = await open();
  db.apply({ chats: [chat("c1", "a")], projects: [project("a")] });
  db.saveMessages("c1", [
    { id: "m1", parts: [], role: "user" },
    { id: "m2", parts: [], role: "assistant" },
    { id: "m3", parts: [], role: "user" },
  ]);

  // The message at 1 is replaced, and what followed it goes.
  db.saveMessages("c1", [{ id: "m2b", parts: [], role: "assistant" }], 1);
  assert.deepEqual(
    db.messages("c1").map((item) => item.id),
    ["m1", "m2b"],
  );

  // Written again in place, then extended.
  db.saveMessages(
    "c1",
    [
      { id: "m2b", parts: [{ text: "Done", type: "text" }], role: "assistant" },
      { id: "m3b", parts: [], role: "user" },
    ],
    1,
  );
  const saved = db.messages("c1");
  assert.deepEqual(
    saved.map((item) => item.id),
    ["m1", "m2b", "m3b"],
  );
  assert.equal(saved[1].parts[0].text, "Done");
  assert.equal(db.catalog().chats[0].messageCount, 3);
});

const message = (id, role, text, extraParts = []) => ({
  id,
  parts: [{ text, type: "text" }, ...extraParts],
  role,
});

test("search finds chats by what their messages say, newest chat first", async () => {
  const db = await open();
  db.apply({
    chats: [
      { ...chat("old", "a"), updatedAt: "2026-01-01T00:00:00.000Z" },
      { ...chat("new", "a"), updatedAt: "2026-02-01T00:00:00.000Z" },
      { ...chat("other", "a"), updatedAt: "2026-03-01T00:00:00.000Z" },
    ],
    projects: [project("a")],
  });
  db.saveMessages("old", [
    message("m1", "user", "Why does the Retry Budget run out?"),
    message("m2", "assistant", "The retry budget is shared by every caller."),
  ]);
  db.saveMessages("new", [message("m1", "user", "raise the retry budget")]);
  db.saveMessages("other", [message("m1", "user", "unrelated")]);

  const { results, truncated } = db.search("  Retry Budget ");

  assert.equal(truncated, false);
  assert.deepEqual(
    results.map((result) => [result.chatId, result.matchCount]),
    [
      ["new", 1],
      ["old", 2],
    ],
  );
  // The latest matching message of the chat, with the text around the match.
  assert.equal(results[1].messageId, "m2");
  assert.equal(results[1].role, "assistant");
  assert.deepEqual(results[1].snippet, {
    after: " is shared by every caller.",
    before: "The ",
    match: "retry budget",
  });
});

test("search reads message text only, and takes LIKE wildcards literally", async () => {
  const db = await open();
  db.apply({ chats: [chat("c1", "a")], projects: [project("a")] });
  db.saveMessages("c1", [
    message("m1", "assistant", 'Set "rate" to 100% of quota', [
      { input: { command: "grep needle" }, type: "tool-bash" },
      { text: "thinking about needle", type: "reasoning" },
    ]),
  ]);

  assert.deepEqual(db.search("needle").results, []);
  assert.deepEqual(db.search("role").results, []);
  assert.deepEqual(db.search("10_%").results, []);
  assert.equal(db.search("100% of").results.length, 1);
  assert.equal(db.search('"rate"').results[0].snippet.match, '"rate"');
  assert.deepEqual(db.search("   "), { results: [], truncated: false });
});

test("search says when it stopped at the chat limit", async () => {
  const db = await open();
  db.apply({
    chats: [chat("c1", "a"), chat("c2", "a")],
    projects: [project("a")],
  });
  db.saveMessages("c1", [message("m1", "user", "deploy it")]);
  db.saveMessages("c2", [message("m1", "user", "deploy again")]);

  const { results, truncated } = db.search("deploy", { limit: 1 });

  assert.equal(results.length, 1);
  assert.equal(truncated, true);
});

const searchTextRows = (databasePath) => {
  const database = new DatabaseSync(databasePath);
  try {
    return database
      .prepare(
        "SELECT message_row, message_id, text FROM chat_message_text ORDER BY message_row",
      )
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
};

test("search text follows every write: a change, a removed message, a removed chat", async () => {
  const db = await open();
  db.apply({
    chats: [chat("c1", "a"), chat("c2", "a")],
    projects: [project("a")],
  });
  db.saveMessages("c1", [
    message("m1", "user", "first draft", [
      { text: "second part", type: "text" },
      { text: "not prose", type: "reasoning" },
    ]),
    { id: "m2", parts: [{ input: {}, type: "tool-bash" }], role: "assistant" },
  ]);
  db.saveMessages("c2", [message("m1", "user", "other chat")]);

  // Text parts only, in order; a message without any has no row.
  assert.deepEqual(searchTextRows(db.databasePath), [
    {
      message_id: "m1",
      message_row: "c1:0:m1",
      text: "first draft\u001fsecond part",
    },
    { message_id: "m1", message_row: "c2:0:m1", text: "other chat" },
  ]);
  // Two parts are searched apart.
  assert.deepEqual(db.search("draft second").results, []);

  db.saveMessages("c1", [message("m1", "user", "final draft")]);
  assert.deepEqual(db.search("first").results, []);
  assert.equal(db.search("final").results[0].chatId, "c1");

  db.apply({ removedChatIds: ["c2"] });
  assert.deepEqual(
    searchTextRows(db.databasePath).map((row) => row.message_row),
    ["c1:0:m1"],
  );
});

test("an older database gets the same search text on upgrade", async () => {
  const db = await open();
  db.apply({ chats: [chat("c1", "a")], projects: [project("a")] });
  db.saveMessages("c1", [
    message("m1", "user", "kept from before", [
      { text: "second", type: "text" },
      { text: 42, type: "text" },
      { text: "thinking", type: "reasoning" },
      ["not", "a", "part"],
    ]),
    { parts: [{ text: "", type: "text" }], role: "assistant" },
    { id: "m3", parts: [{ input: {}, type: "tool-bash" }], role: "user" },
    { id: "m4", parts: "not a list", role: "user" },
  ]);
  closePersistedStateDatabase();
  const written = searchTextRows(db.databasePath);
  assert.equal(written.length, 2);

  // As a build before the search text left it.
  const database = new DatabaseSync(db.databasePath);
  const searchTextMigrationMillis = database
    .prepare(
      "SELECT created_at AS millis FROM __drizzle_migrations ORDER BY created_at LIMIT 1 OFFSET 3",
    )
    .get().millis;
  database.exec(`
    DROP TRIGGER chat_messages_text_delete;
    DROP TABLE chat_message_text;
    DELETE FROM __drizzle_migrations WHERE created_at >= ${searchTextMigrationMillis};
    DROP TABLE device_sessions;
    DROP TABLE delegated_tasks;
    DROP TABLE chat_runs;
    DROP TABLE chat_queues;
    DROP TABLE provider_sessions;
  `);
  database.close();

  assert.equal(db.search("from before").results[0].chatId, "c1");
  // The migration derives from stored payloads what the save path writes.
  closePersistedStateDatabase();
  assert.deepEqual(searchTextRows(db.databasePath), written);
});

test("a transcript reads back as the JSON it was saved as", async () => {
  const db = await open();
  db.apply({ chats: [chat("c1", "a")], projects: [project("a")] });
  const messages = [
    message("m1", "user", 'say "hi" — \\ok'),
    message("m2", "assistant", "hi"),
  ];
  db.saveMessages("c1", messages);
  closePersistedStateDatabase();

  // A payload that is not an object (written by hand) is left out.
  const database = new DatabaseSync(db.databasePath);
  try {
    database
      .prepare(
        `INSERT INTO chat_messages (id, chat_id, role, sort_order, payload, metadata, created_at)
         VALUES ('c1:2:x', 'c1', '', 2, '"stray"', '{}', 'now')`,
      )
      .run();
    const json = loadChatMessagesJson(database, "c1");
    assert.deepEqual(JSON.parse(json), messages);
    assert.equal(loadChatMessagesJson(database, "nope"), "[]");
  } finally {
    database.close();
  }
});
