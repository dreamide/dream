// Agent turn execution owns recording and settlement. Callers supply provider
// execution; they never attach observers or arrange persistence around EOF.
import { turnObservers } from "./agent-turn.js";
import { transcriptFingerprint } from "./session-context.js";

const HOST_ORIGIN = "host";

/**
 * What the host keeps of a turn while it runs: the transcript as the turn
 * writes it (at most once a second, whichever provider runs it) and at the
 * end, and (at the end) the provider session the turn reported, so a turn
 * nobody watched can still be resumed later. The transcript is the
 * client's own request (not what a provider made of it) with the assistant
 * message being written in place of, or after, its last message.
 *
 * The request's messages do not change while the turn runs, so they are
 * saved once, with the first report; every later report saves only the
 * assistant message, at its place after them. How often it is told, and
 * that no report overlaps the one before, is turn-message.js's.
 */
export const createTurnRecorder = ({
  catalog,
  chatId,
  projectPath,
  requestMessages,
  saveIntervalMs,
  onChunk,
  provider,
}) => {
  let resolveDone;
  let saveError;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const continued = requestMessages.at(-1)?.role === "assistant";
  const before = continued ? requestMessages.slice(0, -1) : requestMessages;
  let beforeSaved = false;
  let saving = Promise.resolve();

  const save = (message) => {
    const write = async () => {
      if (beforeSaved) {
        await catalog.saveTranscript(chatId, [message], {
          fromIndex: before.length,
          origin: HOST_ORIGIN,
        });
      } else {
        beforeSaved = await catalog.saveTranscript(
          chatId,
          [...before, message],
          { origin: HOST_ORIGIN },
        );
      }
    };
    saving = saving.then(write, write);
    return saving;
  };

  return {
    // The chat this turn belongs to (agent-turn.js announces its approvals).
    chatId,
    done,
    onChunk,
    onFailure: (error) => {
      saveError = error;
    },
    onEnd: () => resolveDone(saveError),
    saveIntervalMs,
    async onMessage(message, { final }) {
      if (final)
        message = {
          ...message,
          metadata: {
            ...message.metadata,
            completedAt: new Date().toISOString(),
          },
        };
      await save(message);
      if (!final) return;

      const metadata = message?.metadata;
      const sessionId =
        typeof metadata?.remoteConversationId === "string"
          ? metadata.remoteConversationId.trim()
          : "";
      const chat = sessionId ? await catalog.getChat(chatId) : null;
      if (chat && provider && catalog.saveProviderSession) {
        await catalog.saveProviderSession({
          chatId,
          provider,
          session: {
            remoteConversationId: sessionId,
            remoteConversationModel:
              metadata.remoteConversationModel ?? chat.model,
            remoteConversationModelSpeed:
              metadata.remoteConversationModelSpeed ?? chat.modelSpeed,
            remoteConversationProjectPath:
              metadata.remoteConversationProjectPath ?? projectPath,
            lastMessageId: message.id,
            fingerprint: transcriptFingerprint([...before, message]),
            orchestrationToolsVersion: metadata.orchestrationToolsVersion,
          },
        });
      }
      if (!chat || chat.remoteConversationId === sessionId) return;
      await catalog.applyChanges(
        {
          chats: [
            {
              ...chat,
              remoteConversationId: sessionId,
              remoteConversationModel:
                metadata.remoteConversationModel ?? chat.model,
              remoteConversationModelSpeed:
                metadata.remoteConversationModelSpeed ?? chat.modelSpeed,
              remoteConversationProjectPath:
                metadata.remoteConversationProjectPath ?? projectPath,
            },
          ],
        },
        { origin: HOST_ORIGIN },
      );
    },
  };
};

/**
 * Runs a provider behind the production completion seam. Checkpoint capture is
 * best-effort, but its work settles before EOF (also after Stop or stream error).
 * The registry owns consumption, so a disconnected subscriber cannot cancel it.
 */
export const executeAgentTurn = async (
  {
    catalog,
    chatId,
    projectPath,
    requestMessages,
    provider,
    onChunk,
    finalize,
    saveIntervalMs,
  },
  streamTurn,
) => {
  const recorder =
    catalog && chatId
      ? createTurnRecorder({
          catalog,
          chatId,
          projectPath,
          requestMessages,
          provider,
          onChunk,
          saveIntervalMs,
        })
      : null;
  const finalizeCheckpoint = async () => {
    try {
      await finalize?.();
    } catch (error) {
      console.warn("[checkpoints] Failed to finalize checkpoint:", error);
    }
  };
  let response;
  try {
    response = recorder
      ? await turnObservers.run(recorder, streamTurn)
      : await streamTurn();
  } catch (error) {
    await finalizeCheckpoint();
    throw error;
  }
  if (!response?.body || !response.ok) {
    await finalizeCheckpoint();
    return response;
  }

  const reader = response.body.getReader();
  let settlement;
  const settle = () =>
    (settlement ??= (async () => {
      try {
        const error = await recorder?.done;
        if (error) throw error;
      } finally {
        await finalizeCheckpoint();
      }
    })());
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (!done) {
            controller.enqueue(value);
            return;
          }
          await settle();
          controller.close();
        } catch (error) {
          let completionError = error;
          try {
            await settle();
          } catch (failure) {
            completionError = failure;
          }
          controller.error(completionError);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
        await settle();
      },
    }),
    {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    },
  );
};
