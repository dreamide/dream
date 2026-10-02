// Agent turns as host-side objects, detached from the request that started
// them. A turn runs on its own abort signal: the client that asked for it
// can disconnect, reload or quit, and the turn carries on (waiting at a tool
// approval for whichever client answers). Every client that asks receives
// the turn's whole stream from its first byte, so a client that reconnects
// mid-turn rebuilds the message being written (the AI SDK's resumable
// stream). A chat has at most one running turn; only an explicit stop ends
// one early.
//
// The registry owns the response body: it reads it to the end whatever the
// subscribers do, keeping every chunk until the turn ends.

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
  /** @type {Map<string, { controller: AbortController, chunks: Uint8Array[], done: boolean, waiters: Set<() => void>, headers: Headers, status: number }>} */
  const turns = new Map();

  const subscribe = (turn) => {
    let index = 0;
    let waiter = null;
    const stream = new ReadableStream({
      start(controller) {
        const flush = () => {
          while (index < turn.chunks.length) {
            controller.enqueue(turn.chunks[index]);
            index += 1;
          }
          if (turn.done) {
            if (waiter) turn.waiters.delete(waiter);
            controller.close();
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
    return new Response(stream, {
      headers: turn.headers,
      status: turn.status,
    });
  };

  const pump = async (chatId, turn, body) => {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        turn.chunks.push(value);
        for (const waiter of [...turn.waiters]) waiter();
      }
    } catch (error) {
      console.warn(`[turns] ${chatId}: the turn's stream failed.`, error);
    } finally {
      turn.done = true;
      for (const waiter of [...turn.waiters]) waiter();
      turn.waiters.clear();
      if (turns.get(chatId) === turn) turns.delete(chatId);
      onChange({ chatId, running: false });
    }
  };

  return {
    isRunning: (chatId) => turns.has(chatId),

    /** The chats with a turn running now. */
    runningChatIds: () => [...turns.keys()],

    /**
     * Starts a turn. `run` receives the turn's own abort signal and returns
     * the streaming response; what comes back is the first subscriber's
     * view of it. A response without a body (an error answer) is returned
     * as it is and no turn is kept.
     * @param {{ chatId: string, run: (signal: AbortSignal) => Promise<Response> | Response }} options
     */
    async start({ chatId, run }) {
      if (turns.has(chatId)) throw new TurnInProgressError(chatId);

      const controller = new AbortController();
      // Claimed before `run`, so a second start while this one is still
      // setting up is refused too.
      const placeholder = {
        chunks: [],
        controller,
        done: false,
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
      if (!(response instanceof Response) || !response.body) {
        turns.delete(chatId);
        return response;
      }

      placeholder.headers = response.headers;
      placeholder.status = response.status;
      onChange({ chatId, running: true });
      void pump(chatId, placeholder, response.body);
      return subscribe(placeholder);
    },

    /** The running turn's stream from its start, or null when none runs. */
    resume(chatId) {
      const turn = turns.get(chatId);
      return turn ? subscribe(turn) : null;
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
