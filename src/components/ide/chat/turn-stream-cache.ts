/**
 * The bytes of each running turn this client has read, so a reconnect asks
 * the host for only what follows them (electron/api/chat/turn-registry.js).
 *
 * The host names each turn (`x-dream-turn-id`) and says where its answer
 * starts (`x-dream-turn-offset`). When the host answers from the offset this
 * client asked for, the kept bytes are put back in front of its answer, so
 * the AI SDK still reads the turn whole from its first byte (the transport
 * is a replay transport) and rebuilds the same message. A page that has
 * kept nothing (a reload) asks for the whole turn, as before.
 *
 * A turn's bytes are kept while its stream may still be resumed: they are
 * dropped when a stream of it ends, when the host says no turn is running,
 * and when another turn replaces it.
 */

export const TURN_ID_HEADER = "x-dream-turn-id";
export const TURN_OFFSET_HEADER = "x-dream-turn-offset";

interface KeptTurn {
  turnId: string;
  chunks: Uint8Array[];
  length: number;
}

/** What a resume request asked for: the bytes it may put back. */
export interface TurnResumeCursor {
  turnId: string;
  chunks: Uint8Array[];
  length: number;
}

export class TurnStreamMismatchError extends Error {}

export function createTurnStreamCache() {
  const kept = new Map<string, KeptTurn>();

  /** A copy of what is kept for `chatId`, to resume from. */
  const cursor = (chatId: string): TurnResumeCursor | null => {
    const turn = kept.get(chatId);
    if (!turn || turn.length === 0) return null;
    return {
      chunks: [...turn.chunks],
      length: turn.length,
      turnId: turn.turnId,
    };
  };

  /** `url` asking to resume from `resume`'s offset. */
  const resumeUrl = (url: string, resume: TurnResumeCursor | null) => {
    if (!resume) return url;
    const base =
      typeof location === "undefined" ? "http://localhost" : location.href;
    const next = new URL(url, base);
    next.searchParams.set("turn", resume.turnId);
    next.searchParams.set("from", String(resume.length));
    // Keep a relative URL relative: the host endpoint resolves it.
    return /^[a-z][a-z0-9+.-]*:/i.test(url)
      ? next.toString()
      : `${next.pathname}${next.search}`;
  };

  /**
   * The response as the transport should read it: the whole turn, its
   * bytes kept as they arrive. `resume` is what the request asked to
   * resume from (null: from the start).
   */
  const read = (
    chatId: string,
    response: Response,
    resume: TurnResumeCursor | null,
  ): Response => {
    if (response.status === 204) {
      // No turn runs any more: nothing to resume.
      kept.delete(chatId);
      return response;
    }
    const turnId = response.headers.get(TURN_ID_HEADER);
    if (!response.ok || !response.body || !turnId) {
      // An error, or a host that does not name its turns.
      if (!turnId) kept.delete(chatId);
      return response;
    }
    const offset = Number(response.headers.get(TURN_OFFSET_HEADER) ?? 0);
    const resumed =
      resume !== null &&
      offset === resume.length &&
      resume.turnId === turnId &&
      offset > 0;
    if (!resumed && offset !== 0) {
      // A tail this client cannot complete: never show half a turn.
      void response.body.cancel();
      kept.delete(chatId);
      throw new TurnStreamMismatchError(
        "The turn's stream did not match what this window holds.",
      );
    }

    const entry: KeptTurn = resumed
      ? { chunks: [...resume.chunks], length: resume.length, turnId }
      : { chunks: [], length: 0, turnId };
    kept.set(chatId, entry);
    const prefix = resumed ? resume.chunks : [];
    const source = response.body.getReader();
    let index = 0;

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < prefix.length) {
          controller.enqueue(prefix[index]);
          index += 1;
          return;
        }
        try {
          const { done, value } = await source.read();
          if (done) {
            // The turn's stream ended: there is nothing left to resume.
            if (kept.get(chatId) === entry) kept.delete(chatId);
            controller.close();
            return;
          }
          if (kept.get(chatId) === entry) {
            entry.chunks.push(value);
            entry.length += value.length;
          }
          controller.enqueue(value);
        } catch (error) {
          // Kept: the next resume asks for what follows.
          controller.error(error);
        }
      },
      cancel(reason) {
        return source.cancel(reason);
      },
    });
    return new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };

  return {
    cursor,
    read,
    resumeUrl,
    /** Bytes kept for `chatId` (tests and diagnostics). */
    keptLength: (chatId: string) => kept.get(chatId)?.length ?? 0,
    forget: (chatId: string) => kept.delete(chatId),
  };
}
