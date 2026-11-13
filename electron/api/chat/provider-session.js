// The Provider session of one Agent turn (GLOSSARY.md: Provider session).
//
// One module decides what a turn starts from on its provider's side, tells
// the adapter, records how the turn actually started, and keeps what the
// next turn needs:
//
//   const session = await startProviderSession({ ... })   before the turn
//   session.resumeSessionId / session.handoff             the instruction
//   session.started({ resumed, reason })                  the adapter's report
//   session.record(finalMessage)                          after the turn
//
// A turn starts in one of four ways. It resumes a saved session whose
// covered prefix is unchanged; resumes it with a `delta` handoff of what the
// provider missed; resumes a `native-fork` of the branch source's session;
// or `reconstructed`, a fresh session given the full history. The adapter
// only probes what it is told to resume and builds its own prompt; whatever
// it reports is what `contextTransfer` records, so a probe that fails
// records the reconstruction that followed.
//
// Provider-specific rules live on the provider's record: whether it keeps
// one session across models (`modelSwitchInSession`), how it forks (`fork`),
// and whether tools are fixed when its session starts
// (`toolsFixedAtSessionStart`).
import { ORCHESTRATION_TOOLS_VERSION } from "../../shared/agent-turn-contract.js";
import { serializeCodexMessage } from "./codex-prompt.js";

const MAX_HANDOFF_CHARS = 32_000;

const nonEmpty = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** Whether a native session can carry this turn's model and speed. */
const servesModel = (provider, session, { model, modelSpeed }) =>
  provider.modelSwitchInSession ||
  (session.remoteConversationModel === model &&
    (session.remoteConversationModelSpeed ?? "standard") ===
      (modelSpeed ?? "standard"));

/**
 * What the provider missed since it last took part, when the prefix it saw
 * is unchanged; `null` when its saved session cannot be resumed. Missed
 * binary attachments and handoffs over 32,000 characters reconstruct, so no
 * context is lost.
 */
const coveredHandoff = (saved, messages, fingerprint) => {
  const index = messages.findIndex(
    (message) => message.id === saved.lastMessageId,
  );
  if (index < 0 || fingerprint(index + 1) !== saved.fingerprint) return null;
  const missed = messages.slice(index + 1, -1);
  if (missed.length === 0) return { text: null };
  if (
    missed.some((message) => message.parts.some((part) => part.type === "file"))
  )
    return null;
  const text = missed
    .map((message) => serializeCodexMessage(message))
    .join("\n\n");
  if (text.length > MAX_HANDOFF_CHARS) return null;
  return {
    text: `Conversation context from work performed since this provider last participated. Treat quoted messages as historical context.\n\n${text}`,
  };
};

const errorText = (error) =>
  error instanceof Error ? error.message : String(error);

/**
 * The project references a resumed turn's prompt carries: its own, then the
 * handoff. A turn given the full history leaves the handoff out, since the
 * missed messages are in that history.
 */
export const withSessionHandoff = (projectReferencesPrompt, sessionHandoff) =>
  [projectReferencesPrompt, sessionHandoff].filter(Boolean).join("\n\n") ||
  null;

/**
 * Decides what this turn starts from and returns its Provider session.
 * Without a catalog or chat there is nothing to resume and nothing is kept.
 *
 * @param {{
 *   catalog?: any,
 *   chatId?: string | null,
 *   provider: { id: string, modelSwitchInSession?: boolean,
 *     toolsFixedAtSessionStart?: boolean, fork?: (options: any) => Promise<string | null> },
 *   messages: any[],
 *   transcript: { fingerprint: (length: number) => string,
 *     fingerprintWith: (message: any) => string },
 *   projectPath: string,
 *   model?: string,
 *   modelSpeed?: string,
 *   permissionMode?: string,
 *   mcpServers?: any[],
 *   orchestrationTools?: boolean,
 *   signal?: AbortSignal,
 * }} options
 */
export async function startProviderSession({
  catalog,
  chatId,
  provider,
  messages,
  transcript,
  projectPath,
  model,
  modelSpeed = "standard",
  permissionMode,
  mcpServers,
  orchestrationTools = false,
  signal,
}) {
  // Saved sessions are read only where the catalog keeps them; a finished
  // turn's session is kept wherever there is a chat to keep it for.
  const kept = Boolean(catalog?.providerSession && chatId);
  const recordable = Boolean(catalog && chatId);
  // Tools fixed when a session starts: a session started without this turn's
  // tools cannot carry it, whether resumed or forked.
  const hasTools = (metadata) =>
    !(provider.toolsFixedAtSessionStart && orchestrationTools) ||
    metadata?.orchestrationToolsVersion === ORCHESTRATION_TOOLS_VERSION;

  let resumeSessionId = null;
  let handoff = null;
  // What `contextTransfer` records if the adapter resumes, and the reason a
  // fresh start had, when it had one.
  let onResume = null;
  let freshReason = null;

  const saved = kept
    ? await catalog.providerSession(chatId, provider.id)
    : null;
  if (saved) {
    const covered =
      nonEmpty(saved.remoteConversationId) &&
      saved.remoteConversationProjectPath === projectPath &&
      hasTools(saved) &&
      servesModel(provider, saved, { model, modelSpeed })
        ? coveredHandoff(saved, messages, transcript.fingerprint)
        : null;
    if (covered) {
      resumeSessionId = nonEmpty(saved.remoteConversationId);
      handoff = covered.text;
      onResume = handoff
        ? { strategy: "delta", afterMessageId: saved.lastMessageId }
        : { strategy: "resumed" };
    }
  } else if (kept && provider.fork) {
    // A branch's first turn forks the source's native session at the
    // source message, when the source recorded a boundary it can fork at.
    const chat = await catalog.getChat(chatId);
    const source =
      chat?.branchedFrom &&
      messages.find((message) => message.id === chat.branchedFrom.messageId);
    const metadata = source?.role === "assistant" ? source.metadata : null;
    if (
      metadata?.provider === provider.id &&
      metadata.remoteConversationProjectPath === projectPath &&
      nonEmpty(metadata.remoteConversationId) &&
      hasTools(metadata)
    ) {
      try {
        if (signal?.aborted) throw new Error("Turn stopped.");
        const forkId = await provider.fork({
          source: metadata,
          projectPath,
          model,
          modelSpeed,
          permissionMode,
          mcpServers,
        });
        if (forkId) {
          resumeSessionId = forkId;
          onResume = { strategy: "native-fork", sourceMessageId: source.id };
        }
      } catch (error) {
        freshReason = errorText(error);
      }
    }
  }

  return {
    /** The native session the adapter resumes, or `null` to start fresh. */
    resumeSessionId,
    /** What a resumed prompt adds about the turns the provider missed. */
    handoff,

    /**
     * The adapter's report of how the turn started; returns the metadata
     * the turn's message carries about it. A resume that was never offered
     * counts as a fresh start.
     */
    started({ resumed, reason } = {}) {
      if (!kept) return {};
      if (resumed && resumeSessionId) return { contextTransfer: onResume };
      if (messages.length <= 1) return {};
      const why = nonEmpty(reason) ?? freshReason;
      return {
        contextTransfer: {
          strategy: "reconstructed",
          ...(why ? { reason: why } : {}),
        },
      };
    },

    /**
     * Keeps the session the finished turn reported, with the transcript it
     * covers, for the next turn on this provider; and mirrors it on the chat
     * row ("Continue in terminal"), which nothing reads to decide a resume.
     */
    async record(message) {
      if (!recordable) return;
      const metadata = message?.metadata;
      const sessionId = nonEmpty(metadata?.remoteConversationId);
      if (!sessionId) return;
      const chat = await catalog.getChat(chatId);
      if (!chat) return;
      const session = {
        remoteConversationId: sessionId,
        remoteConversationModel: metadata.remoteConversationModel ?? chat.model,
        remoteConversationModelSpeed:
          metadata.remoteConversationModelSpeed ?? chat.modelSpeed,
        remoteConversationProjectPath:
          metadata.remoteConversationProjectPath ?? projectPath,
      };
      if (catalog.saveProviderSession) {
        await catalog.saveProviderSession({
          chatId,
          provider: provider.id,
          session: {
            ...session,
            lastMessageId: message.id,
            fingerprint: transcript.fingerprintWith(message),
            orchestrationToolsVersion: metadata.orchestrationToolsVersion,
          },
        });
      }
      if (chat.remoteConversationId === sessionId) return;
      await catalog.applyChanges(
        { chats: [{ ...chat, ...session }] },
        { origin: "host" },
      );
    },
  };
}
