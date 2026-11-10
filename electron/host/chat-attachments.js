// A chat's attachments as files an agent can open. The transcript holds the
// bytes, so these are a cache of it: each turn writes whatever is missing,
// at a path that stays the same for as long as the chat exists. A chat's
// files go when its row does (soft-deleted chats keep theirs, like their
// transcript).
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAttachmentExtensionFromMediaType,
  getAttachmentLabel,
  getMessageFileParts,
  isImageAttachment,
  isImageFilePart,
  parseAttachmentDataUrl,
  sanitizeAttachmentFilename,
} from "../shared/attachment-content.js";

const MAX_FILENAME_LENGTH = 100;

const hash = (value, length) =>
  createHash("sha256").update(value).digest("hex").slice(0, length);

/** Beside the state database: one host per database owns its contents. */
const attachmentsRoot = async () => {
  try {
    // Temporary turn files do not need the workspace's SQLite modules.
    const { resolveStateDatabasePath } = await import("../persisted-state.js");
    return `${resolveStateDatabasePath()}.attachments`;
  } catch {
    // No host is configured, so nothing owns a place to keep files.
    return null;
  }
};

// Chat ids come from clients: hashing keeps one from naming another folder.
const chatDirectoryName = (chatId) => hash(chatId, 32);

const attachmentFilename = (part, mediaType) => {
  const fallback = `attachment${getAttachmentExtensionFromMediaType(mediaType)}`;
  const name = sanitizeAttachmentFilename(part.filename, fallback)
    .replace(/^\.+/, "")
    .slice(-MAX_FILENAME_LENGTH);
  return name || fallback;
};

const writeIfMissing = async (filePath, buffer) => {
  const existing = await fs.stat(filePath).catch(() => null);
  // A different size is a write that never finished.
  if (existing?.size === buffer.length) return;
  await fs.mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
  await fs.writeFile(filePath, buffer, { mode: 0o600 });
};

/**
 * Saves every attachment in `messages` that a provider cannot take inline
 * (images it can).
 * @param {{ chatId?: string | null, messages: unknown[] }} options
 * @returns {Promise<{ directory: string | null, filePaths: Map<object, string> }>}
 *   `filePaths`: each saved file part's path; a part that could not be saved
 *   is left out. `directory`: what holds them, when any were saved.
 */
export const saveChatAttachments = async ({ chatId, messages }) => {
  const filePaths = new Map();
  const root = await attachmentsRoot();
  if (!root || !chatId) return { directory: null, filePaths };

  const directory = path.join(root, chatDirectoryName(chatId));
  for (const message of messages) {
    if (message?.role !== "user") continue;
    for (const part of getMessageFileParts(message)) {
      const parsed = parseAttachmentDataUrl(part.url);
      if (!parsed || isImageFilePart(part)) continue;
      // By content, so sending the same file again reuses its path.
      const filePath = path.join(
        directory,
        hash(parsed.buffer, 16),
        attachmentFilename(part, part.mediaType ?? parsed.mediaType),
      );
      try {
        await writeIfMissing(filePath, parsed.buffer);
        filePaths.set(part, filePath);
      } catch (error) {
        console.warn("Unable to save a chat attachment.", error);
      }
    }
  }
  return { directory: filePaths.size > 0 ? directory : null, filePaths };
};

/**
 * Removes the files of every chat the catalog no longer has. Run after
 * removals rather than per chat: a removed project takes its chats with it,
 * and a folder that could not be deleted (a file held open) goes next time.
 * A chat with a turn running is kept even if its row has not arrived yet.
 * @param {{ list: () => Promise<{ chats: { id: string }[], runningChatIds: string[] }> }} catalog
 */
export const sweepChatAttachments = async (catalog) => {
  const root = await attachmentsRoot();
  if (!root) return;
  try {
    const entries = await fs.readdir(root).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    if (entries.length === 0) return;

    const { chats, runningChatIds } = await catalog.list();
    const kept = new Set(
      [...chats.map((chat) => chat.id), ...runningChatIds].map(
        chatDirectoryName,
      ),
    );
    await Promise.all(
      entries
        .filter((entry) => !kept.has(entry))
        .map((entry) =>
          fs.rm(path.join(root, entry), { force: true, recursive: true }),
        ),
    );
  } catch (error) {
    console.warn("Unable to clean up chat attachments.", error);
  }
};

/**
 * Temporary attachment files belong to this execution, including preparation.
 * Awaiting the callback keeps the files until provider execution settles; a
 * failed write or Stop during preparation still reaches the same release.
 * The host's stream consumer, not an observing client, owns that execution.
 */
export const withTemporaryChatAttachments = async (
  { messages, signal },
  run,
) => {
  signal?.throwIfAborted();
  const message = messages?.findLast((entry) => entry?.role === "user");
  const fileParts = getMessageFileParts(message);
  if (fileParts.length === 0) return run(null);

  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "dream-chat-attachments-"),
  );
  try {
    signal?.throwIfAborted();
    const promptLines = ["Current turn attachments:"];
    for (const [index, part] of fileParts.entries()) {
      signal?.throwIfAborted();
      const label = getAttachmentLabel(part);
      const parsed = parseAttachmentDataUrl(part.url);
      const mediaType =
        (typeof part.mediaType === "string" && part.mediaType.trim()) ||
        parsed?.mediaType ||
        null;
      if (!parsed) {
        promptLines.push(
          `- ${label}${mediaType ? ` (${mediaType})` : ""}: attachment payload unavailable in the chat.`,
        );
        continue;
      }
      const fallback = `attachment-${index + 1}${getAttachmentExtensionFromMediaType(mediaType)}`;
      const filename = sanitizeAttachmentFilename(part.filename, fallback);
      const filePath = path.join(directory, `${index + 1}-${filename}`);
      await fs.writeFile(filePath, parsed.buffer, { mode: 0o600, signal });
      const isImage = isImageAttachment(mediaType, filePath);
      promptLines.push(
        `- ${label}${mediaType ? ` (${mediaType})` : ""}: ${filePath}${isImage ? " [also passed via --image]" : ""}`,
      );
    }
    signal?.throwIfAborted();
    return await run({ promptText: promptLines.join("\n") });
  } finally {
    await fs
      .rm(directory, { force: true, recursive: true, maxRetries: 3 })
      .catch((error) => {
        console.warn("Unable to release temporary chat attachments.", error);
      });
  }
};
