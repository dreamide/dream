import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { closePersistedStateDatabase } from "../persisted-state.js";
import { createInThreadStateWriter } from "../state-writes.js";
import { createHostCatalog } from "./catalog.js";
import {
  saveChatAttachments,
  sweepChatAttachments,
} from "./chat-attachments.js";
import { configureHostDataDirectory } from "./host-paths.js";

const XLSX = "application/vnd.ms-excel";
const dataUrl = (mediaType, text) =>
  `data:${mediaType};base64,${Buffer.from(text).toString("base64")}`;
const filePart = (filename, text = "PK-bytes", mediaType = XLSX) => ({
  filename,
  mediaType,
  type: "file",
  url: dataUrl(mediaType, text),
});
const userMessage = (...parts) => ({ parts, role: "user" });

let directory;
let root;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "dream-attachments-"));
  configureHostDataDirectory(directory);
  root = path.join(directory, "dream.db.attachments");
});
afterEach(async () => {
  closePersistedStateDatabase();
  await fs.rm(directory, { force: true, recursive: true });
});

const save = async (chatId, ...parts) =>
  saveChatAttachments({ chatId, messages: [userMessage(...parts)] });

test("saves a file's exact bytes under its own name", async () => {
  const part = filePart("grid-stripe-integration.xlsx", "PK\u0003\u0004bytes");
  const { directory: chatDirectory, filePaths } = await save("chat-1", part);

  const filePath = filePaths.get(part);
  assert.equal(path.basename(filePath), "grid-stripe-integration.xlsx");
  assert.ok(filePath.startsWith(`${chatDirectory}${path.sep}`));
  assert.equal(await fs.readFile(filePath, "utf8"), "PK\u0003\u0004bytes");
});

test("a later turn finds the same path, and repairs a lost or partial file", async () => {
  const part = filePart("report.xlsx", "complete bytes");
  const first = (await save("chat-1", part)).filePaths.get(part);
  assert.equal((await save("chat-1", part)).filePaths.get(part), first);

  await fs.writeFile(first, "comp");
  await save("chat-1", part);
  assert.equal(await fs.readFile(first, "utf8"), "complete bytes");

  await fs.rm(first);
  await save("chat-1", part);
  assert.equal(await fs.readFile(first, "utf8"), "complete bytes");
});

test("same-named files with different contents do not overwrite each other", async () => {
  const before = filePart("export.xlsx", "version one");
  const after = filePart("export.xlsx", "version two");
  const { filePaths } = await save("chat-1", before, after);

  assert.notEqual(filePaths.get(before), filePaths.get(after));
  assert.equal(await fs.readFile(filePaths.get(before), "utf8"), "version one");
  assert.equal(await fs.readFile(filePaths.get(after), "utf8"), "version two");
});

test("client-supplied names cannot leave the chat's folder", async () => {
  for (const [chatId, filename] of [
    ["../../escape", "report.xlsx"],
    ["chat-1", "../../../escape.xlsx"],
    ["chat-1", ".."],
    ["chat-1", "..\\..\\escape.xlsx"],
  ]) {
    const part = filePart(filename);
    const { directory: chatDirectory, filePaths } = await save(chatId, part);
    assert.equal(path.dirname(chatDirectory), root);
    assert.ok(filePaths.get(part).startsWith(`${chatDirectory}${path.sep}`));
    assert.ok((await fs.stat(filePaths.get(part))).isFile());
  }
  assert.deepEqual(
    (await fs.readdir(directory)).sort(),
    ["dream.db.attachments"],
    "nothing was written beside the attachments folder",
  );
});

test("keeps images inline and skips parts without bytes", async () => {
  const image = filePart("shot.png", "png", "image/png");
  const missing = { ...filePart("gone.xlsx"), url: "blob:http://dream/1" };
  const { directory: chatDirectory, filePaths } = await save(
    "chat-1",
    image,
    missing,
  );
  assert.equal(filePaths.size, 0);
  assert.equal(chatDirectory, null);
});

test("saves nothing without a chat to keep it for", async () => {
  const part = filePart("report.xlsx");
  const { directory: chatDirectory, filePaths } = await saveChatAttachments({
    messages: [userMessage(part)],
  });
  assert.equal(chatDirectory, null);
  assert.equal(filePaths.size, 0);
});

test("a failed write leaves that file out instead of failing the turn", async () => {
  await fs.writeFile(root, "a file where the folder should be");
  const part = filePart("report.xlsx");
  const { directory: chatDirectory, filePaths } = await save("chat-1", part);
  assert.equal(filePaths.size, 0);
  assert.equal(chatDirectory, null);
});

test("the sweep removes only chats the catalog no longer has", async () => {
  const save3 = async (chatId) => {
    const part = filePart(`${chatId}.xlsx`);
    return (await save(chatId, part)).filePaths.get(part);
  };
  const live = await save3("live");
  const running = await save3("running");
  const removed = await save3("removed");

  await sweepChatAttachments({
    list: async () => ({
      chats: [{ id: "live" }],
      runningChatIds: ["running"],
    }),
  });

  assert.equal(await fs.readFile(live, "utf8"), "PK-bytes");
  assert.equal(await fs.readFile(running, "utf8"), "PK-bytes");
  await assert.rejects(fs.stat(removed), { code: "ENOENT" });
});

test("a sweep that cannot read the catalog deletes nothing", async () => {
  const part = filePart("report.xlsx");
  const filePath = (await save("chat-1", part)).filePaths.get(part);
  await sweepChatAttachments({
    list: async () => {
      throw new Error("database busy");
    },
  });
  assert.equal(await fs.readFile(filePath, "utf8"), "PK-bytes");
});

test("removing a chat or its project removes its files; soft delete keeps them", async () => {
  let swept = Promise.resolve();
  const catalog = createHostCatalog({
    events: { publish: () => {} },
    getWriter: () => createInThreadStateWriter(),
    onChatsRemoved: () => {
      swept = sweepChatAttachments(catalog);
    },
  });
  const chat = (id, projectId, deletedAt = null) => ({
    deletedAt,
    id,
    projectId,
    title: id,
  });
  await catalog.applyChanges({
    chats: [chat("kept", "a"), chat("alone", "a"), chat("cascaded", "b")],
    projects: [
      { id: "a", name: "a", path: path.join(directory, "a") },
      { id: "b", name: "b", path: path.join(directory, "b") },
    ],
  });
  const saved = {};
  for (const id of ["kept", "alone", "cascaded"]) {
    const part = filePart(`${id}.xlsx`);
    saved[id] = (await save(id, part)).filePaths.get(part);
  }

  await catalog.applyChanges({
    chats: [chat("kept", "a", new Date().toISOString())],
  });
  await swept;
  assert.ok(await fs.stat(saved.kept), "a soft-deleted chat can be restored");

  await catalog.applyChanges({ removedChatIds: ["alone"] });
  await swept;
  await assert.rejects(fs.stat(saved.alone), { code: "ENOENT" });
  assert.ok(await fs.stat(saved.cascaded));

  await catalog.applyChanges({ removedProjectIds: ["b"] });
  await swept;
  await assert.rejects(fs.stat(saved.cascaded), { code: "ENOENT" });
  assert.ok(await fs.stat(saved.kept));
});
