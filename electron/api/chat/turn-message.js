// The assistant message an Agent turn is writing, as the host follows it.
//
// The host reads its own copy of every turn's UI-message stream, whichever
// provider adapter wrote it, and builds the message with the AI SDK's chat
// (the machinery the client's useChat runs on), so the host's copy is put
// together exactly as the client's is. That chat changes one message in
// place; a copy is taken only when the message is reported, never per
// chunk, so following a turn costs one copy per report however many tool
// calls it makes.
//
// Reports are paced by time alone: at most once per `intervalMs` while the
// message changes, never while the previous report is still being handled,
// and once at the end, also after an error or a stop. No provider has to
// mark steps for its turn to be reported while it runs.

import { AbstractChat } from "ai";

/**
 * Chat state holding the messages as they are: the chat writes the live
 * message here, by reference, as each chunk changes it.
 */
const createLiveState = (messages, onWrite) => ({
  error: undefined,
  messages,
  status: "ready",
  pushMessage(message) {
    this.messages = [...this.messages, message];
    onWrite();
  },
  popMessage() {
    this.messages = this.messages.slice(0, -1);
  },
  replaceMessage(index, message) {
    this.messages = this.messages.with(index, message);
    onWrite();
  },
  snapshot: (value) => structuredClone(value),
});

/**
 * An error chunk is the client's to show and never changes the message;
 * the chat would stop following at one, so the host's copy leaves them out.
 */
const withoutErrors = () =>
  new TransformStream({
    transform(chunk, controller) {
      if (chunk?.type !== "error") controller.enqueue(chunk);
    },
  });

/**
 * Follows `stream` (UI-message chunks) and calls `report(message, { final })`
 * with the caller's own copy of the assistant message so far. A turn whose
 * request ends with an assistant message continues that message; the
 * request itself is never changed. A report that fails before the end is
 * the caller's to handle; a failed final report rejects. Resolves after the
 * final report, and rejects afterwards if the stream itself failed.
 * @param {ReadableStream} stream
 * @param {{
 *   originalMessages?: unknown[],
 *   intervalMs: number,
 *   report: (message: unknown, options: { final: boolean }) => Promise<unknown> | unknown,
 * }} options
 */
export const followTurnMessage = async (
  stream,
  { originalMessages, intervalMs, report },
) => {
  const last = Array.isArray(originalMessages)
    ? originalMessages.at(-1)
    : undefined;
  const continued = last?.role === "assistant" ? last : null;

  let changed = false;
  let ended = false;
  let timer = null;
  let reporting = null;
  // A turn shorter than one interval is reported once, at its end.
  let lastReportAt = Date.now();

  const current = () => {
    const message = chat.lastMessage;
    return message?.role === "assistant" && message !== last ? message : null;
  };

  const reportChange = () => {
    timer = null;
    const message = current();
    if (ended || !changed || !message) return;
    changed = false;
    lastReportAt = Date.now();
    const copy = structuredClone(message);
    // A failed report is the caller's to handle; following goes on.
    reporting = Promise.resolve()
      .then(() => report(copy, { final: false }))
      .catch(() => {})
      .finally(() => {
        reporting = null;
        schedule();
      });
  };

  const schedule = () => {
    if (ended || !changed || timer || reporting) return;
    timer = setTimeout(
      reportChange,
      Math.max(0, lastReportAt + intervalMs - Date.now()),
    );
  };

  let failure = null;
  const chat = new AbstractChat({
    onError: (error) => {
      failure = error;
    },
    state: createLiveState(continued ? [continued] : [], () => {
      changed = true;
      schedule();
    }),
    transport: {
      reconnectToStream: async () => null,
      sendMessages: async () => stream.pipeThrough(withoutErrors()),
    },
  });

  try {
    await chat.sendMessage();
  } finally {
    ended = true;
    clearTimeout(timer);
    timer = null;
    await reporting?.catch(() => {});
    const message = current() ?? continued;
    if (message) await report(structuredClone(message), { final: true });
  }
  if (failure) throw failure;
};
