// The output stage behind the agent-turn writer: one flow policy for every
// provider, whatever its adapter writes.
//
// Providers stream prose a token at a time. Each delta is a chunk, and each
// chunk costs on the host's main thread: the SSE line, the copy the turn
// registry keeps for a client that reconnects, and the transcript
// observer's snapshot of the whole message so far. So consecutive deltas of
// one part are joined: a delta waits at most `maxDelayMs` (50 ms, the
// renderer's own update rate) for the next one, and anything that is not a
// delta of the same part releases it first, so chunk order never changes.
//
// Only plain deltas are joined (text, reasoning, tool input); a delta that
// carries anything else (provider metadata) passes through as it is.

export const TURN_DELTA_FLUSH_MS = 50;

/** For each delta chunk type: the field naming its part, and its text. */
const DELTA_FIELDS = {
  "reasoning-delta": { part: "id", text: "delta" },
  "text-delta": { part: "id", text: "delta" },
  "tool-input-delta": { part: "toolCallId", text: "inputTextDelta" },
};

/** The fields of `chunk` when it is a delta that may be joined, else null. */
const joinableFields = (chunk) => {
  const fields = DELTA_FIELDS[chunk?.type];
  if (!fields || typeof chunk[fields.text] !== "string") return null;
  for (const key of Object.keys(chunk)) {
    if (key !== "type" && key !== fields.part && key !== fields.text) {
      return null;
    }
  }
  return fields;
};

/**
 * A TransformStream of UI message chunks that joins consecutive deltas of
 * one part.
 * @param {{
 *   maxDelayMs?: number | null,
 *   setTimer?: (callback: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 * }} [options]
 *   `maxDelayMs`: how long a delta may wait for the next; null waits for
 *   the next chunk that is not one (or the end), for a reader that only
 *   wants the message at boundaries.
 */
export const createDeltaJoiner = ({
  clearTimer = clearTimeout,
  maxDelayMs = TURN_DELTA_FLUSH_MS,
  setTimer = setTimeout,
} = {}) => {
  /** The delta being held, with its fields. */
  let held = null;
  let timer = null;
  let readable = null;

  const release = (controller) => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (held) {
      const { chunk } = held;
      held = null;
      controller.enqueue(chunk);
    }
  };

  return new TransformStream({
    start(controller) {
      readable = controller;
    },
    transform(chunk, controller) {
      const fields = joinableFields(chunk);
      if (!fields) {
        release(controller);
        controller.enqueue(chunk);
        return;
      }
      if (
        held &&
        held.chunk.type === chunk.type &&
        held.chunk[fields.part] === chunk[fields.part]
      ) {
        held.chunk[fields.text] += chunk[fields.text];
        return;
      }
      release(controller);
      held = { chunk: { ...chunk } };
      if (maxDelayMs !== null) {
        timer = setTimer(() => {
          timer = null;
          try {
            release(readable);
          } catch {
            // The stream already ended or was cancelled.
          }
        }, maxDelayMs);
      }
    },
    flush(controller) {
      release(controller);
    },
  });
};
