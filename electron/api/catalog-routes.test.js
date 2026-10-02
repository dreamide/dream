// The catalog routes and their events, against a real host database.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, test } from "vitest";
import { createHostCatalog } from "../host/catalog.js";
import { configureHostDataDirectory } from "../host/host-paths.js";
import {
  applyPersistedCatalogChanges,
  closePersistedStateDatabase,
  savePersistedChatMessages,
} from "../persisted-state.js";
import { CLIENT_ID_HEADER, registerCatalogRoutes } from "./catalog-routes.js";

let directory = null;
afterEach(async () => {
  closePersistedStateDatabase();
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = null;
});

const setup = async () => {
  directory = await mkdtemp(path.join(tmpdir(), "dream-catalog-routes-"));
  configureHostDataDirectory(directory);
  const events = [];
  const catalog = createHostCatalog({
    events: { publish: (event) => events.push(event) },
    // In place of the save queue: the same writes, in this thread.
    getWriter: () => ({
      applyCatalogChanges: async (changes) =>
        applyPersistedCatalogChanges(changes),
      saveChatMessages: async (payload) => savePersistedChatMessages(payload),
    }),
  });
  const app = new Hono();
  registerCatalogRoutes(app, catalog);
  const call = async (method, route, body, clientId = "client-a") => {
    const response = await app.request(route, {
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        [CLIENT_ID_HEADER]: clientId,
      },
      method,
    });
    return { body: await response.json(), status: response.status };
  };
  return { call, events };
};

test("a change is applied and announced with the client that made it", async () => {
  const { call, events } = await setup();

  const { body } = await call("POST", "/api/catalog/changes", {
    chats: [{ id: "c1", projectId: "p1", title: "Hello" }],
    projects: [{ id: "p1", path: "/work/p1", ui: { multiChat: true } }],
  });

  assert.deepEqual(body.chatIds, ["c1"]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "changes");
  assert.equal(events[0].origin, "client-a");
  assert.equal(events[0].projects[0].id, "p1");
  // What other clients hear carries no workspace fields.
  assert.equal(events[0].projects[0].ui, undefined);
  assert.equal(events[0].chats[0].title, "Hello");

  const listed = await call("POST", "/api/catalog", {});
  assert.deepEqual(
    listed.body.chats.map((chat) => chat.id),
    ["c1"],
  );
});

test("a change that applies nothing announces nothing", async () => {
  const { call, events } = await setup();

  await call("POST", "/api/catalog/changes", {
    chats: [{ id: "c1", projectId: "no-such-project" }],
  });

  assert.deepEqual(events, []);
});

test("transcripts are read and replaced, and the replacement announced", async () => {
  const { call, events } = await setup();
  await call("POST", "/api/catalog/changes", {
    chats: [{ id: "c1", projectId: "p1" }],
    projects: [{ id: "p1", path: "/work/p1" }],
  });

  const saved = await call(
    "PUT",
    "/api/catalog/transcript",
    {
      chatId: "c1",
      messages: [{ id: "m1", parts: [], role: "user" }],
    },
    "client-b",
  );
  const read = await call("POST", "/api/catalog/transcript", { chatId: "c1" });

  assert.deepEqual(saved.body, { saved: true });
  assert.deepEqual(read.body, [{ id: "m1", parts: [], role: "user" }]);
  assert.deepEqual(events.at(-1), {
    chatId: "c1",
    kind: "transcript",
    messageCount: 1,
    origin: "client-b",
  });

  const missing = await call("PUT", "/api/catalog/transcript", {
    chatId: "nope",
    messages: [],
  });
  assert.deepEqual(missing.body, { saved: false });
});
