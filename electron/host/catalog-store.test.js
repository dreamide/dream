// The host catalog's rows: granular changes that touch only what they name.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  applyPersistedCatalogChanges,
  closePersistedStateDatabase,
  loadPersistedCatalog,
  loadPersistedChatMessages,
  savePersistedChatMessages,
} from "../persisted-state.js";

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
    apply: (changes) => applyPersistedCatalogChanges(changes, { databasePath }),
    catalog: () => loadPersistedCatalog({ databasePath }),
    messages: (chatId) => loadPersistedChatMessages(chatId, { databasePath }),
    saveMessages: (chatId, messages) =>
      savePersistedChatMessages({ chatId, messages }, { databasePath }),
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
