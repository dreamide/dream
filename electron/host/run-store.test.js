import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  closePersistedStateDatabase,
  getPersistedStateDatabase,
} from "../persisted-state.js";
import { applyCatalogChanges } from "./catalog-store.js";
import { mutateRunQueue, readRunQueue } from "./run-store.js";

const tempDirs = [];

const openDb = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dream-run-store-test-"));
  tempDirs.push(dir);
  const databasePath = path.join(dir, "state.db");
  const db = getPersistedStateDatabase({ databasePath });
  applyCatalogChanges(
    db,
    {
      chats: [
        {
          createdAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
          id: "c1",
          model: "gpt-5",
          projectId: "p1",
          provider: "openai",
          title: "Chat 1",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      projects: [
        {
          createdAt: "2026-01-01T00:00:00.000Z",
          id: "p1",
          metadata: {},
          name: "Project 1",
          path: "/tmp/p1",
          sortOrder: 0,
          status: "open",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    },
    "2026-01-01T00:00:00.000Z",
  );
  return db;
};

afterEach(async () => {
  closePersistedStateDatabase();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { force: true, recursive: true });
    }
  }
});

test("chat_runs and delegated_tasks indexes are used by hot queue queries", async () => {
  const db = await openDb();
  const explain = (sql, ...params) =>
    db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail)
      .join("\n");

  const tailPlan = explain(
    "SELECT id FROM chat_runs WHERE chat_id = ? ORDER BY position DESC LIMIT 20",
    "c1",
  );
  assert.match(tailPlan, /idx_chat_runs_chat_position/);

  const maxPositionPlan = explain(
    "SELECT COALESCE(MAX(position), 0) + 1 FROM chat_runs WHERE chat_id = ?",
    "c1",
  );
  assert.match(maxPositionPlan, /idx_chat_runs_chat_position/);

  const livePlan = explain(
    "SELECT id FROM chat_runs WHERE status IN ('running', 'waiting')",
  );
  assert.match(livePlan, /idx_chat_runs_live/);

  const parentRunPlan = explain(
    "SELECT id FROM delegated_tasks WHERE parent_run_id = ?",
    "r1",
  );
  assert.match(parentRunPlan, /idx_delegated_tasks_parent_run/);
});

test("settled runs strip inline data URLs while preserving retry payloads and idempotency", async () => {
  const db = await openDb();
  const largeDataUrl = `data:image/png;base64,${"A".repeat(8192)}`;
  const request = {
    model: "gpt-5",
    provider: "openai",
    message: {
      id: "m1",
      role: "user",
      parts: [
        { text: "inspect screenshot", type: "text" },
        { mediaType: "image/png", type: "file", url: largeDataUrl },
      ],
    },
  };

  assert.deepEqual(
    mutateRunQueue(db, { chatId: "c1", id: "r1", request, type: "enqueue" }),
    { duplicate: false, id: "r1" },
  );

  // Claiming and failing keeps the full payload so retry still sees attachment bytes.
  const claimed = mutateRunQueue(db, { chatId: "c1", type: "claim" });
  assert.equal(claimed?.request.message.parts[1].url, largeDataUrl);
  mutateRunQueue(db, {
    chatId: "c1",
    error: "transient",
    id: "r1",
    status: "failed",
    type: "status",
  });
  const failedRaw = db
    .prepare("SELECT request FROM chat_runs WHERE id = 'r1'")
    .get().request;
  assert.ok(failedRaw.includes(largeDataUrl));

  // Retrying and completing strips the inline base64 payload.
  mutateRunQueue(db, { chatId: "c1", id: "r1", type: "retry" });
  mutateRunQueue(db, { chatId: "c1", type: "resume" });
  const retried = mutateRunQueue(db, { chatId: "c1", type: "claim" });
  assert.equal(retried?.request.message.parts[1].url, largeDataUrl);
  mutateRunQueue(db, {
    chatId: "c1",
    id: "r1",
    status: "completed",
    type: "status",
  });

  const completedRaw = db
    .prepare("SELECT request FROM chat_runs WHERE id = 'r1'")
    .get().request;
  assert.ok(completedRaw.length < 512);
  assert.ok(!completedRaw.includes("A".repeat(128)));
  assert.match(completedRaw, /data:image\/png;sha256=[0-9a-f]{64}/);

  // Queue read still sees provider, model, and text preview.
  const queue = readRunQueue(db, "c1");
  assert.equal(queue.runs[0]?.provider, "openai");
  assert.equal(queue.runs[0]?.model, "gpt-5");
  assert.equal(queue.runs[0]?.text, "inspect screenshot");

  // Re-submitting the identical request after completion is still idempotent.
  assert.deepEqual(
    mutateRunQueue(db, { chatId: "c1", id: "r1", request, type: "enqueue" }),
    { duplicate: true, id: "r1" },
  );

  // Re-submitting with different attachment bytes under the same ID still rejects.
  assert.throws(
    () =>
      mutateRunQueue(db, {
        chatId: "c1",
        id: "r1",
        request: {
          ...request,
          message: {
            ...request.message,
            parts: [
              { text: "inspect screenshot", type: "text" },
              {
                mediaType: "image/png",
                type: "file",
                url: `data:image/png;base64,${"B".repeat(8192)}`,
              },
            ],
          },
        },
        type: "enqueue",
      }),
    /different submission/,
  );
});
