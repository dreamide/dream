// Stable row cursors; paging never copies the entire transcript into a reader.
function selectTranscriptPage(database, { chatId, before, limit = 40 }) {
  let end = Number.MAX_SAFE_INTEGER;
  if (before) {
    const boundary = database
      .prepare(
        "SELECT sort_order FROM chat_messages WHERE chat_id = ? AND id = ?",
      )
      .get(chatId, before);
    if (!boundary) throw new Error("History changed. Reload the conversation.");
    end = boundary.sort_order;
  }
  const rows = database
    .prepare(
      "SELECT id, sort_order, payload FROM chat_messages WHERE chat_id = ? AND sort_order < ? ORDER BY sort_order DESC, id DESC LIMIT ?",
    )
    .iterate(chatId, end, Math.min(200, Math.max(1, limit)));
  const selected = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(row.payload);
    if (selected.length && bytes + size > 1_048_576) break;
    selected.push(row);
    bytes += size;
  }
  selected.reverse();
  const total = database
    .prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE chat_id = ?")
    .get(chatId).count;
  const first = selected[0];
  return {
    selected,
    total,
    startIndex: first?.sort_order ?? 0,
    before: first?.sort_order > 0 ? first.id : null,
  };
}

export function readTranscriptPage(database, request) {
  const { selected, total, startIndex, before } = selectTranscriptPage(
    database,
    request,
  );
  return {
    messages: selected.map((row) => JSON.parse(row.payload)),
    total,
    startIndex,
    before,
  };
}

/**
 * Same page as `readTranscriptPage`, assembled directly as JSON text so the
 * read worker avoids parsing payloads only for the host thread to re-stringify
 * them into the HTTP response.
 */
export function readTranscriptPageJson(database, request) {
  const { selected, total, startIndex, before } = selectTranscriptPage(
    database,
    request,
  );
  const messagesJson = selected.map((row) => row.payload).join(",");
  return `{"messages":[${messagesJson}],"total":${total},"startIndex":${startIndex},"before":${JSON.stringify(before)}}`;
}
