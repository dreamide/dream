import { createHash } from "node:crypto";
import { chatToRow } from "../shared/persisted-state-codec.js";

const permissionRank = { ask: 0, "auto-accept-edits": 1, "full-access": 2 };

export const readDelegatedTasks = (db, parentChatId) =>
  db
    .prepare(`
  SELECT d.id, d.child_chat_id AS childChatId, d.parent_run_id AS parentRunId,
    r.status, r.error, r.updated_at AS updatedAt, c.title,
    json_extract(r.request, '$.model') AS model,
    substr(json_extract(r.request, '$.message.parts[0].text'), 1, 1500) AS prompt
  FROM delegated_tasks d JOIN chat_runs r ON r.id = d.id
  JOIN chats c ON c.id = d.child_chat_id
  WHERE d.parent_chat_id = ? ORDER BY r.created_at, d.id
`)
    .all(parentChatId);

// Called inside the queue writer's transaction: identity, chat and queued intent
// either all commit or none do. Providers never receive the catalog write token.
export function enqueueDelegatedTask(
  db,
  { chatId, id: parentRunId, request: input },
  enqueue,
) {
  const parent = db
    .prepare("SELECT * FROM chat_runs WHERE id = ? AND chat_id = ?")
    .get(parentRunId, chatId);
  if (
    !parent ||
    !["running", "waiting"].includes(parent.status) ||
    db.prepare("SELECT paused FROM chat_queues WHERE chat_id = ?").get(chatId)
      ?.paused
  ) {
    throw new Error("Parent turn is no longer active.");
  }
  const original = JSON.parse(parent.request);
  const permissionMode =
    input.permissionMode ?? original.permissionMode ?? "full-access";
  if (
    !(permissionMode in permissionRank) ||
    permissionRank[permissionMode] >
      permissionRank[original.permissionMode ?? "full-access"]
  ) {
    throw new Error("A delegated task cannot exceed its parent's permissions.");
  }
  const id = `task-${createHash("sha256").update(`${parentRunId}\0${input.key}`).digest("hex")}`;
  const parentChat = db.prepare("SELECT * FROM chats WHERE id = ?").get(chatId);
  const now = new Date().toISOString();
  const request = {
    ...original,
    provider: input.provider,
    model: input.model,
    modelLabel: input.model,
    modelSpeed: "standard",
    reasoningEffort: null,
    reasoningLabel: undefined,
    modelSpeedLabel: undefined,
    projectReferences: [],
    permissionMode,
    projectId: parentChat.project_id,
    remoteConversationId: null,
    remoteConversationModel: null,
    remoteConversationModelSpeed: null,
    remoteConversationProjectPath: null,
    message: {
      id: `${id}-prompt`,
      role: "user",
      parts: [{ type: "text", text: input.prompt }],
    },
  };
  const existing = db
    .prepare("SELECT id FROM delegated_tasks WHERE id = ?")
    .get(id);
  if (!existing) {
    const depth = db
      .prepare(`WITH RECURSIVE ancestors(id, depth) AS (
      SELECT parent_chat_id, 1 FROM delegated_tasks WHERE child_chat_id = ?
      UNION ALL SELECT d.parent_chat_id, a.depth + 1 FROM delegated_tasks d JOIN ancestors a ON d.child_chat_id = a.id
    ) SELECT COALESCE(MAX(depth), 0) AS depth FROM ancestors`)
      .get(chatId).depth;
    if (depth >= 4) throw new Error("Delegation depth limit reached.");
    const count = db
      .prepare(`SELECT COUNT(*) AS count FROM delegated_tasks d JOIN chat_runs r ON r.id = d.id
      WHERE d.parent_chat_id = ? AND r.status IN ('queued', 'running', 'waiting')`)
      .get(chatId).count;
    if (count >= 8)
      throw new Error(
        "Wait for an existing delegated task before starting another.",
      );
    db.prepare(
      "INSERT INTO chats (id, project_id, title, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      parentChat.project_id,
      `Task: ${input.prompt.slice(0, 100)}`,
      JSON.stringify(
        chatToRow({
          id,
          projectId: parentChat.project_id,
          model: input.model,
          provider: input.provider,
          permissionMode,
        }).metadata,
      ),
      now,
      now,
    );
  }
  const receipt = enqueue({ type: "enqueue", chatId: id, id, request });
  if (!existing)
    db.prepare(
      "INSERT INTO delegated_tasks (id, parent_chat_id, parent_run_id, child_chat_id) VALUES (?, ?, ?, ?)",
    ).run(id, chatId, parentRunId, id);
  return { ...receipt, childChatId: id };
}
