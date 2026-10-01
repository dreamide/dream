// The host side of the terminal stream: what the process-session manager
// emits (output batches and status changes) fans out to every connected
// client over the terminal socket, and what clients send back (input,
// resize, acknowledgments) reaches the sessions.
//
// Output batches carry the `generation` and `sequence` the flow control
// already stamps on them (terminal-output.js). The stream keeps the recent
// batches of each live session so a client that reconnects can say where it
// stopped ("resume") and be sent only what it missed. The budget is larger
// than the flow-control high watermark, so every batch a client has not yet
// acknowledged is still retained.

export const TERMINAL_REPLAY_BUDGET = 512 * 1024;

const GAP_NOTICE =
  "\r\n\u001b[2m[terminal] Some output was dropped while disconnected.\u001b[0m\r\n";

/**
 * @typedef {{ send: (text: string) => void }} TerminalStreamClient
 * @typedef {{
 *   writeTerminalInput: (payload: { sessionId: string, data: string }) => void,
 *   resizeTerminal: (payload: { sessionId: string, cols: number, rows: number }) => void,
 *   acknowledgeTerminalOutput: (payload: { sessionId: string, generation: string, sequence: number }) => void,
 * }} TerminalStreamSessions
 */

export function createTerminalStream({
  replayBudget = TERMINAL_REPLAY_BUDGET,
} = {}) {
  /** @type {Set<TerminalStreamClient>} */
  const clients = new Set();
  /** sessionId -> { generation, batches: {sequence, chunk}[], size } */
  const retained = new Map();
  /** sessionId -> the last "running" status event */
  const running = new Map();
  /** @type {TerminalStreamSessions | null} */
  let sessions = null;

  const sendTo = (client, message) => {
    try {
      client.send(JSON.stringify(message));
    } catch {
      // A client whose socket is closing is dropped by its close handler.
    }
  };

  const broadcast = (message) => {
    for (const client of clients) sendTo(client, message);
  };

  const retain = ({ sessionId, generation, sequence, chunk }) => {
    let entry = retained.get(sessionId);
    if (!entry || entry.generation !== generation) {
      entry = { generation, batches: [], size: 0 };
      retained.set(sessionId, entry);
    }
    entry.batches.push({ sequence, chunk });
    entry.size += chunk.length;
    while (entry.size > replayBudget && entry.batches.length > 1) {
      entry.size -= entry.batches.shift().chunk.length;
    }
  };

  /** The process-session manager's emitter. */
  const publish = (channel, payload) => {
    if (!payload || typeof payload.sessionId !== "string") return;

    if (channel === "terminal:data") {
      if (
        typeof payload.generation === "string" &&
        typeof payload.sequence === "number"
      ) {
        retain(payload);
      }
      broadcast({ type: "data", ...payload });
      return;
    }

    if (channel === "terminal:status") {
      if (payload.status === "running") {
        running.set(payload.sessionId, payload);
      } else {
        running.delete(payload.sessionId);
        retained.delete(payload.sessionId);
      }
      broadcast({ type: "status", ...payload });
    }
  };

  const replay = (client, cursor) => {
    const { sessionId } = cursor;
    const status = running.get(sessionId);
    if (!status) {
      // The session ended while the client was away.
      sendTo(client, { type: "status", sessionId, status: "stopped" });
      return;
    }

    sendTo(client, { type: "status", ...status });
    const entry = retained.get(sessionId);
    if (!entry || entry.batches.length === 0) return;

    const sameGeneration = cursor.generation === entry.generation;
    const after =
      sameGeneration && Number.isInteger(cursor.sequence) ? cursor.sequence : 0;
    const missed = entry.batches.filter((batch) => batch.sequence > after);
    if (missed.length === 0) return;

    if (missed[0].sequence > after + 1) {
      sendTo(client, { type: "data", sessionId, chunk: GAP_NOTICE });
    }
    for (const batch of missed) {
      sendTo(client, {
        type: "data",
        sessionId,
        generation: entry.generation,
        sequence: batch.sequence,
        chunk: batch.chunk,
      });
    }
  };

  const receive = (client, text) => {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    switch (message.type) {
      case "resume":
        if (Array.isArray(message.sessions)) {
          for (const cursor of message.sessions) {
            if (cursor && typeof cursor.sessionId === "string") {
              replay(client, cursor);
            }
          }
        }
        return;
      case "input":
        if (typeof message.sessionId === "string") {
          sessions?.writeTerminalInput({
            sessionId: message.sessionId,
            data: message.data,
          });
        }
        return;
      case "resize":
        if (typeof message.sessionId === "string") {
          sessions?.resizeTerminal({
            sessionId: message.sessionId,
            cols: message.cols,
            rows: message.rows,
          });
        }
        return;
      case "ack":
        if (typeof message.sessionId === "string") {
          sessions?.acknowledgeTerminalOutput({
            sessionId: message.sessionId,
            generation: message.generation,
            sequence: message.sequence,
          });
        }
        return;
      default:
    }
  };

  return {
    publish,

    /** @param {TerminalStreamSessions} target */
    bindSessions(target) {
      sessions = target;
    },

    /**
     * Attaches a client. Returns its handlers: `receive` for each text
     * message it sends, `close` when its socket goes away.
     * @param {TerminalStreamClient} client
     */
    connect(client) {
      clients.add(client);
      return {
        receive: (text) => receive(client, text),
        close: () => {
          clients.delete(client);
        },
      };
    },

    getClientCount: () => clients.size,
  };
}
