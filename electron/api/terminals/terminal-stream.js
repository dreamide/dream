// The terminal channel of the host socket (host-socket/host-socket.js): what
// the process-session manager emits (output batches and status changes)
// goes to every connected client, and what clients send back (input,
// resize, acknowledgments) reaches the sessions.
//
// Output batches carry the `generation` and `sequence` the flow control
// already stamps on them (terminal-output.js). The channel keeps the recent
// batches of each live session so a client that reconnects can say where it
// stopped and be sent only what it missed. The budget is larger than the
// flow-control high watermark, so every batch a client has not yet
// acknowledged is still retained.
//
// Messages, all with `channel: "terminal"`:
//   host -> client   data {sessionId, chunk, generation?, sequence?}
//                    status {sessionId, status, transport?, shell?, pid?, ...}
//   client -> host   input {sessionId, data}
//                    resize {sessionId, cols, rows}
//                    ack {sessionId, generation, sequence}
// Its resume cursor: [{sessionId, generation, sequence}, ...].

export const TERMINAL_CHANNEL = "terminal";
export const TERMINAL_REPLAY_BUDGET = 512 * 1024;

const GAP_NOTICE =
  "\r\n\u001b[2m[terminal] Some output was dropped while disconnected.\u001b[0m\r\n";

/**
 * @typedef {{
 *   writeTerminalInput: (payload: { sessionId: string, data: string }) => void,
 *   resizeTerminal: (payload: { sessionId: string, cols: number, rows: number }) => void,
 *   acknowledgeTerminalOutput: (payload: { sessionId: string, generation: string, sequence: number }) => void,
 * }} TerminalStreamSessions
 */

/**
 * @param {{
 *   broadcast: (message: object) => void,
 *   replayBudget?: number,
 * }} options
 *   `broadcast`: sends a message to every client of the host socket.
 */
export function createTerminalStream({
  broadcast,
  replayBudget = TERMINAL_REPLAY_BUDGET,
}) {
  /** sessionId -> { generation, batches: {sequence, chunk}[], size } */
  const retained = new Map();
  /** sessionId -> the last "running" status event */
  const running = new Map();
  /** @type {TerminalStreamSessions | null} */
  let sessions = null;

  const message = (type, payload) => ({
    channel: TERMINAL_CHANNEL,
    type,
    ...payload,
  });

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
  const publish = (event, payload) => {
    if (!payload || typeof payload.sessionId !== "string") return;

    if (event === "terminal:data") {
      if (
        typeof payload.generation === "string" &&
        typeof payload.sequence === "number"
      ) {
        retain(payload);
      }
      broadcast(message("data", payload));
      return;
    }

    if (event === "terminal:status") {
      if (payload.status === "running") {
        running.set(payload.sessionId, payload);
      } else {
        running.delete(payload.sessionId);
        retained.delete(payload.sessionId);
      }
      broadcast(message("status", payload));
    }
  };

  const replaySession = (send, cursor) => {
    const { sessionId } = cursor;
    const status = running.get(sessionId);
    if (!status) {
      // The session ended while the client was away.
      send(message("status", { sessionId, status: "stopped" }));
      return;
    }

    send(message("status", status));
    const entry = retained.get(sessionId);
    if (!entry || entry.batches.length === 0) return;

    const sameGeneration = cursor.generation === entry.generation;
    const after =
      sameGeneration && Number.isInteger(cursor.sequence) ? cursor.sequence : 0;
    const missed = entry.batches.filter((batch) => batch.sequence > after);
    if (missed.length === 0) return;

    if (missed[0].sequence > after + 1) {
      send(message("data", { sessionId, chunk: GAP_NOTICE }));
    }
    for (const batch of missed) {
      send(
        message("data", {
          sessionId,
          generation: entry.generation,
          sequence: batch.sequence,
          chunk: batch.chunk,
        }),
      );
    }
  };

  return {
    publish,

    /** @param {TerminalStreamSessions} target */
    bindSessions(target) {
      sessions = target;
    },

    /**
     * Sends a reconnecting client what it missed.
     * @param {(message: object) => void} send to that client only
     * @param {unknown} cursors the channel's resume cursor
     */
    resume(send, cursors) {
      if (!Array.isArray(cursors)) return;
      for (const cursor of cursors) {
        if (cursor && typeof cursor.sessionId === "string") {
          replaySession(send, cursor);
        }
      }
    },

    /** A message a client sent on this channel. */
    receive(incoming) {
      if (typeof incoming.sessionId !== "string") return;
      switch (incoming.type) {
        case "input":
          sessions?.writeTerminalInput({
            sessionId: incoming.sessionId,
            data: incoming.data,
          });
          return;
        case "resize":
          sessions?.resizeTerminal({
            sessionId: incoming.sessionId,
            cols: incoming.cols,
            rows: incoming.rows,
          });
          return;
        case "ack":
          sessions?.acknowledgeTerminalOutput({
            sessionId: incoming.sessionId,
            generation: incoming.generation,
            sequence: incoming.sequence,
          });
          return;
        default:
      }
    },
  };
}
