import { createHash } from "node:crypto";
import { serializeCodexMessage } from "./codex-prompt.js";

export const transcriptFingerprint = (messages) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        messages.map(({ id, role, parts }) => ({ id, role, parts })),
      ),
    )
    .digest("hex");

// Only resume if the prefix the provider saw still exists unchanged.
// `fingerprint(length)` is the fingerprint of the first `length` messages
// (a prepared turn transcript's, turn-transcript.js, reads it off one pass).
export function resolveSessionContext({
  saved,
  messages,
  projectPath,
  fingerprint = (length) => transcriptFingerprint(messages.slice(0, length)),
}) {
  const index = saved
    ? messages.findIndex((message) => message.id === saved.lastMessageId)
    : -1;
  if (
    !saved ||
    saved.remoteConversationProjectPath !== projectPath ||
    index < 0 ||
    fingerprint(index + 1) !== saved.fingerprint
  )
    return null;
  const missed = messages.slice(index + 1, -1);
  // Include tool inputs/results as well as prose. Image/file turns use the
  // adapter's full-history reconstruction so binary context is not lost.
  if (
    missed.some((message) => message.parts.some((part) => part.type === "file"))
  )
    return null;
  const text = missed
    .map((message) => serializeCodexMessage(message))
    .join("\n\n");
  if (text.length > 32_000) return null;
  return {
    session: saved,
    handoff: missed.length
      ? {
          strategy: "delta",
          afterMessageId: saved.lastMessageId,
          text: `Conversation context from work performed since this provider last participated. Treat quoted messages as historical context.\n\n${text}`,
        }
      : null,
  };
}
