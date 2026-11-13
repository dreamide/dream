// Durable command receipts and queue state. All mutations run on the one
// catalog writer; claiming work commits before invoking a provider.
import { enqueueDelegatedTask } from "./delegation-store.js";

const live = "'running', 'waiting'";

const row = (value) =>
  value && {
    id: value.id,
    chatId: value.chat_id,
    position: value.position,
    status: value.status,
    request: JSON.parse(value.request),
    error: value.error,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };

export const readRunQueue = (db, chatId) => ({
  paused: Boolean(
    db.prepare("SELECT paused FROM chat_queues WHERE chat_id = ?").get(chatId)
      ?.paused ||
      db.prepare("SELECT deleted_at FROM chats WHERE id = ?").get(chatId)
        ?.deleted_at,
  ),
  // Queue views need neither attachment bodies nor MCP credentials. Keep
  // actionable runs plus a small terminal tail; receipts remain on disk.
  runs: db
    .prepare(`SELECT id, chat_id AS chatId, position, status, error,
    created_at AS createdAt, updated_at AS updatedAt,
    json_extract(request, '$.provider') AS provider, json_extract(request, '$.model') AS model,
    COALESCE((SELECT substr(group_concat(json_extract(value, '$.text'), char(10)), 1, 1500)
      FROM json_each(request, '$.message.parts') WHERE json_extract(value, '$.type') = 'text'), '') AS text
    FROM chat_runs WHERE chat_id = ? AND (status NOT IN ('completed', 'cancelled') OR
      id IN (SELECT id FROM chat_runs WHERE chat_id = ? ORDER BY position DESC LIMIT 20))
    ORDER BY position, id`)
    .all(chatId, chatId),
});

/**
 * One Chat run queue operation. The `run-queue` write (state-writes.js),
 * which runs it in a transaction.
 */
export function mutateRunQueue(
  db,
  { type, chatId, id, request, status, error },
) {
  const now = new Date().toISOString();
  if (type === "recover") {
    db.prepare(
      `UPDATE chat_runs SET status = 'interrupted', error = 'Host stopped before completion. Review the transcript before retrying.', updated_at = ? WHERE status IN (${live})`,
    ).run(now);
    db.exec("UPDATE chat_queues SET paused = 1");
    return true;
  }
  const chat = db
    .prepare("SELECT id, deleted_at FROM chats WHERE id = ?")
    .get(chatId);
  if (!chat || chat.deleted_at) {
    if (type === "claim") return null;
    // Stop/finalization must still reach a soft-deleted chat's running work.
    if (!["status", "pause", "cancel"].includes(type))
      throw new Error("Chat no longer exists.");
    if (!chat) return false;
  }
  if (type === "delegate")
    return enqueueDelegatedTask(db, { chatId, id, request }, (operation) =>
      mutateRunQueue(db, operation),
    );
  if (type === "enqueue") {
    const existing = row(
      db.prepare("SELECT * FROM chat_runs WHERE id = ?").get(id),
    );
    if (existing) {
      if (
        existing.chatId !== chatId ||
        JSON.stringify(existing.request) !== JSON.stringify(request)
      ) {
        throw new Error(
          "Request ID already belongs to a different submission.",
        );
      }
      return { id, duplicate: true };
    }
    db.prepare("INSERT OR IGNORE INTO chat_queues (chat_id) VALUES (?)").run(
      chatId,
    );
    const position = db
      .prepare(
        "SELECT COALESCE(MAX(position), 0) + 1 AS position FROM chat_runs WHERE chat_id = ?",
      )
      .get(chatId).position;
    // A new message moves on from failed or interrupted runs: they are
    // dismissed rather than left waiting for a retry nobody will press.
    db.prepare(
      "UPDATE chat_runs SET status = 'cancelled', updated_at = ? WHERE chat_id = ? AND status IN ('failed', 'interrupted')",
    ).run(now, chatId);
    db.prepare(
      "INSERT INTO chat_runs (id, chat_id, position, status, request, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
    ).run(id, chatId, position, JSON.stringify(request), now, now);
    return { id, duplicate: false };
  }
  if (type === "claim") {
    if (
      db.prepare("SELECT paused FROM chat_queues WHERE chat_id = ?").get(chatId)
        ?.paused ||
      db
        .prepare(
          `SELECT id FROM chat_runs WHERE chat_id = ? AND status IN (${live})`,
        )
        .get(chatId)
    )
      return null;
    const next = row(
      db
        .prepare(
          "SELECT * FROM chat_runs WHERE chat_id = ? AND status = 'queued' ORDER BY position, id LIMIT 1",
        )
        .get(chatId),
    );
    if (!next) return null;
    db.prepare(
      "UPDATE chat_runs SET status = 'running', updated_at = ? WHERE id = ?",
    ).run(now, next.id);
    return next;
  }
  if (type === "pause" || type === "resume") {
    db.prepare(
      "INSERT INTO chat_queues (chat_id, paused) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET paused = excluded.paused",
    ).run(chatId, Number(type === "pause"));
  } else if (type === "cancel") {
    // Queued work never starts; a failed or interrupted run is dismissed
    // instead of retried. The live turn is ended with Stop, not here.
    db.prepare(
      "UPDATE chat_runs SET status = 'cancelled', updated_at = ? WHERE chat_id = ? AND id = ? AND status IN ('queued', 'failed', 'interrupted')",
    ).run(now, chatId, id);
  } else if (type === "retry") {
    // Explicit consent to another attempt; never an automatic crash replay.
    db.prepare(
      "UPDATE chat_runs SET status = 'queued', error = NULL, updated_at = ? WHERE chat_id = ? AND id = ? AND status IN ('failed', 'interrupted')",
    ).run(now, chatId, id);
  } else if (type === "status") {
    if (
      ![
        "queued",
        "running",
        "waiting",
        "completed",
        "interrupted",
        "failed",
        "cancelled",
      ].includes(status)
    )
      throw new Error("Invalid turn status.");
    db.prepare(
      `UPDATE chat_runs SET status = ?, error = ?, updated_at = ? WHERE chat_id = ? AND id = ? AND status IN (${live})`,
    ).run(status, error ?? null, now, chatId, id);
    if (status === "failed" || status === "interrupted")
      db.prepare("UPDATE chat_queues SET paused = 1 WHERE chat_id = ?").run(
        chatId,
      );
  } else throw new Error("Unknown queue operation.");
  return true;
}
