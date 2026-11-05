// Agent turns as host-side objects, detached from the request that started
// them. A turn runs on its own abort signal: the client that asked for it
// can disconnect, reload or quit, and the turn carries on (waiting at a tool
// approval for whichever client answers). Every client that asks receives
// the turn's whole stream from its first byte, so a client that reconnects
// mid-turn rebuilds the message being written (the AI SDK's resumable
// stream). A chat has at most one running turn; only an explicit stop ends
// one early.
//
// Each turn has an id (`x-dream-turn-id` on every view of it). A client
// that kept the first N bytes of a turn asks for that turn from N and gets
// only the rest (`x-dream-turn-offset: N`); it splices its own copy in
// front, so what it reads is still the whole stream. Any other request (no
// id, another turn's id, an offset the turn has not reached) gets the
// stream from its first byte, at offset 0.
//
// The registry owns the response body: it reads it to the end whatever the
// subscribers do, keeping every chunk until the turn ends.

import { randomUUID } from "node:crypto";

export const TURN_ID_HEADER = "x-dream-turn-id";
export const TURN_OFFSET_HEADER = "x-dream-turn-offset";

export class TurnInProgressError extends Error {
  constructor(chatId) {
    super("A turn is already running in this chat.");
    this.name = "TurnInProgressError";
    this.chatId = chatId;
    this.httpStatus = 409;
  }
}

/**
 * @param {{ onChange?: (event: { chatId: string, running: boolean }) => void }} [options]
 *   `onChange`: told when a turn starts and when it ends.
 */
export function createTurnRegistry({ onChange = () => {} } = {}) {
  /** @type {Map<string, { id: string, controller: AbortController, chunks: Uint8Array[], length: number, done: boolean, waiters: Set<() => void>, headers: Headers, status: number }>} */
  const turns = new Map();

  /** A view of `turn` from byte `from` (a boundary it has reached). */
  const subscribe = (turn, from = 0) => {
    // The chunk holding byte `from`, and where in it the view starts.
    let index = 0;
    let skip = from;
    while (index < turn.chunks.length && skip >= turn.chunks[index].length) {
      skip -= turn.chunks[index].length;
      index += 1;
    }
    let waiter = null;
    const stream = new ReadableStream({
      start(controller) {
        const flush = () => {
          while (index < turn.chunks.length) {
            const chunk = turn.chunks[index];
            controller.enqueue(skip > 0 ? chunk.subarray(skip) : chunk);
            skip = 0;
            index += 1;
          }
          if (turn.done) {
            if (waiter) turn.waiters.delete(waiter);
            if (turn.failure) controller.error(turn.failure);
            else controller.close();
          }
        };
        flush();
        if (!turn.done) {
          waiter = flush;
          turn.waiters.add(waiter);
        }
      },
      cancel() {
        // This subscriber went away; the turn does not.
        if (waiter) turn.waiters.delete(waiter);
      },
    });
    const headers = new Headers(turn.headers);
    headers.set(TURN_ID_HEADER, turn.id);
    headers.set(TURN_OFFSET_HEADER, String(from));
    return new Response(stream, { headers, status: turn.status });
  };

  const pump = async (chatId, turn, body) => {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        turn.chunks.push(value);
        turn.length += value.length;
        for (const waiter of [...turn.waiters]) waiter();
      }
    } catch (error) {
      turn.failure = error;
      console.warn(`[turns] ${chatId}: the turn's stream failed.`, error);
    } finally {
      turn.done = true;
      for (const waiter of [...turn.waiters]) waiter();
      turn.waiters.clear();
      if (turns.get(chatId) === turn) turns.delete(chatId);
      onChange({ chatId, running: false });
    }
  };

  const start = async ({ chatId, run }, observe) => {
    if (turns.has(chatId)) throw new TurnInProgressError(chatId);

    const controller = new AbortController();
    // Claimed before `run`, so a second start while this one is still
    // setting up is refused too.
    const placeholder = {
      id: randomUUID(),
      chunks: [],
      length: 0,
      controller,
      done: false,
      ready: false,
      headers: new Headers(),
      status: 200,
      waiters: new Set(),
    };
    turns.set(chatId, placeholder);

    let response;
    try {
      response = await run(controller.signal);
    } catch (error) {
      turns.delete(chatId);
      throw error;
    }
    if (!(response instanceof Response) || !response.body || !response.ok) {
      turns.delete(chatId);
      if (!observe && !response?.ok)
        throw new Error(response ? await response.text() : "No turn response.");
      return observe ? response : undefined;
    }

    placeholder.headers = response.headers;
    placeholder.status = response.status;
    placeholder.ready = true;
    onChange({ chatId, running: true });
    const completion = pump(chatId, placeholder, response.body);
    if (observe) return subscribe(placeholder);
    await completion;
    if (placeholder.failure) throw placeholder.failure;
  };

  return {
    isRunning: (chatId) => turns.has(chatId),

    /** The chats with a turn running now. */
    runningChatIds: () => [...turns.keys()],
    /** Only streams whose response headers are ready can be reattached. */
    streamingChatIds: () =>
      [...turns].filter(([, turn]) => turn.ready).map(([chatId]) => chatId),

    /**
     * Starts a turn. `run` receives the turn's own abort signal and returns
     * the streaming response; what comes back is the first subscriber's
     * view of it. A response without a body (an error answer) is returned
     * as it is and no turn is kept.
     * @param {{ chatId: string, run: (signal: AbortSignal) => Promise<Response> | Response }} options
     */
    start: (options) => start(options, true),

    /** Runs to completion without creating a replay subscriber. */
    run: (options) => start(options, false),

    /**
     * The running turn's stream, or null when none runs: from `from` when
     * `turnId` names it and it has reached that byte, else from its start.
     * @param {string} chatId
     * @param {{ turnId?: string | null, from?: number | null }} [cursor]
     */
    resume(chatId, { turnId = null, from = null } = {}) {
      const turn = turns.get(chatId);
      if (!turn?.ready) return null;
      const offset =
        turnId === turn.id &&
        Number.isSafeInteger(from) &&
        from > 0 &&
        from <= turn.length
          ? from
          : 0;
      return subscribe(turn, offset);
    },

    /** Stops a running turn. False when none runs. */
    stop(chatId) {
      const turn = turns.get(chatId);
      if (!turn) return false;
      turn.controller.abort();
      return true;
    },

    /** Stops every turn (the host is shutting down). */
    stopAll() {
      for (const turn of turns.values()) turn.controller.abort();
    },
  };
}
