/**
 * Following host turns: which running turns this client follows, and what
 * it does when a followed stream is lost (GLOSSARY.md: Turn stream).
 *
 * A turn runs on its host whether or not any client watches it. This client
 * follows one into a chat's session: when the session starts, when the host
 * says a turn started, after a submit, and after the connection recovers.
 * It follows each chat once at a time; a request made while one is under
 * way runs after it. A stream lost while its turn still runs (a dropped
 * body, a transient host answer) is followed again, with a delay that
 * doubles up to a ceiling and resets once bytes arrive. Following stops
 * when the turn ends, when the host cannot be reached, or when the session
 * is replaced or dropped. A stream still open a while after the host says
 * its turn ended has stalled: it is dropped, and the session settles on
 * the saved transcript instead.
 *
 * What following does (load the transcript, resume the stream, refresh)
 * belongs to the chat runtime (chat-runtime.ts), which supplies it.
 */
export const MIN_FOLLOW_RETRY_MS = 250;
export const MAX_FOLLOW_RETRY_MS = 5_000;
/**
 * How long a followed stream may stay open after the host says its turn
 * ended: the end event can overtake the stream's last bytes.
 */
export const ENDED_STREAM_GRACE_MS = 5_000;

export interface TurnFollowingDependencies<Session extends { chatId: string }> {
  /** A turn runs on the chat's host and this client may connect to it. */
  canFollow: (chatId: string) => boolean;
  /** Whether `session` is still its chat's session. */
  isCurrent: (session: Session) => boolean;
  /** Whether the session's own stream is open (a submit, a follow). */
  isStreaming: (session: Session) => boolean;
  /** Drops the session's stream: only this client stops following. */
  stopStream: (session: Session) => void;
  /**
   * Follows the running turn to its end. Resolves true when the stream
   * ended cleanly; rejects as the stream does.
   */
  follow: (session: Session) => Promise<boolean>;
  /** A follow failed; `lost` may be called from here. */
  onError: (session: Session, error: Error) => void;
  /** A follow ended, however, while its session is current. */
  onSettled: (session: Session) => void;
  hostOf: (chatId: string) => string;
  timers?: {
    set: (callback: () => void, ms: number) => unknown;
    clear: (timer: unknown) => void;
  };
}

interface Following {
  /** The stream was lost while the turn may run on. */
  lost: boolean;
  /** The wait before following a lost stream again. */
  delay: number;
  retry: unknown;
  /** The wait for the current follow's stream to close after its turn ended. */
  ending: unknown;
  /** The current follow was dropped because its turn had ended. */
  ended: boolean;
}

export const createTurnFollowing = <Session extends { chatId: string }>(
  deps: TurnFollowingDependencies<Session>,
) => {
  const timers = deps.timers ?? {
    clear: (timer: unknown) =>
      clearTimeout(timer as ReturnType<typeof setTimeout>),
    set: (callback: () => void, ms: number) => setTimeout(callback, ms),
  };
  /** Chats followed right now, each with its follow's session. */
  const active = new Map<string, Session>();
  /** Chats to follow again once their current follow (or stream) ends. */
  const pending = new Set<string>();
  const states = new Map<string, Following>();
  const stateOf = (chatId: string) => {
    let state = states.get(chatId);
    if (!state) {
      state = {
        delay: MIN_FOLLOW_RETRY_MS,
        ended: false,
        ending: null,
        lost: false,
        retry: null,
      };
      states.set(chatId, state);
    }
    return state;
  };
  const cancelRetry = (state: Following) => {
    if (state.retry !== null) {
      timers.clear(state.retry);
      state.retry = null;
    }
  };
  const cancelEnding = (state: Following) => {
    if (state.ending !== null) {
      timers.clear(state.ending);
      state.ending = null;
    }
  };

  const follow = (session: Session, { newTurn = false } = {}) => {
    const { chatId } = session;
    // A turn that starts while this session streams (its own submit, or a
    // follow under way) is followed once that ends.
    if (newTurn && (deps.isStreaming(session) || active.has(chatId)))
      pending.add(chatId);
    if (
      !deps.canFollow(chatId) ||
      deps.isStreaming(session) ||
      active.has(chatId)
    )
      return;
    const state = stateOf(chatId);
    cancelRetry(state);
    state.ended = false;
    active.set(chatId, session);
    pending.delete(chatId);
    void deps
      .follow(session)
      .then((ended) => {
        if (ended) state.lost = false;
      })
      .catch((error: Error) => deps.onError(session, error))
      .finally(() => {
        active.delete(chatId);
        cancelEnding(state);
        if (!deps.isCurrent(session)) return;
        deps.onSettled(session);
        if (pending.delete(chatId)) {
          follow(session);
        } else if (state.lost && deps.canFollow(chatId)) {
          const delay = state.delay;
          state.delay = Math.min(delay * 2, MAX_FOLLOW_RETRY_MS);
          state.retry = timers.set(() => {
            state.retry = null;
            follow(session);
          }, delay);
        }
      });
  };

  return {
    follow,

    /**
     * Follows every running turn on `hostId` again on a fresh stream: after
     * a suspend or a lost connection, a stream that looks open may be dead.
     * One being read is dropped and followed again once it ends.
     */
    reattach(hostId: string, sessions: Iterable<Session>) {
      for (const session of sessions) {
        if (deps.hostOf(session.chatId) !== hostId) continue;
        if (deps.isStreaming(session) || active.has(session.chatId)) {
          pending.add(session.chatId);
          deps.stopStream(session);
        } else {
          follow(session);
        }
      }
    },

    /**
     * The host says the chat's turn ended. The stream being followed
     * should close with it; one still open after a grace period has
     * stalled, and is dropped so the session settles on the saved
     * transcript (onSettled). A follow that starts later is not affected.
     */
    ended(chatId: string) {
      const session = active.get(chatId);
      if (!session) return;
      const state = stateOf(chatId);
      cancelEnding(state);
      state.ending = timers.set(() => {
        state.ending = null;
        if (active.get(chatId) !== session) return;
        state.ended = true;
        deps.stopStream(session);
      }, ENDED_STREAM_GRACE_MS);
    },

    /**
     * Whether the chat's current or last follow was dropped because its
     * turn had ended: its stream's end is not an interruption.
     */
    isEnded: (chatId: string) => states.get(chatId)?.ended ?? false,

    /** The chat's stream was lost while its turn may run on. */
    lost(chatId: string) {
      stateOf(chatId).lost = true;
    },

    /** Whether the chat's stream was lost and is to be followed again. */
    isLost: (chatId: string) => states.get(chatId)?.lost ?? false,

    /** The chat's stream failed for good: nothing to follow again. */
    failed(chatId: string) {
      const state = states.get(chatId);
      if (state) state.lost = false;
    },

    /**
     * Bytes arrived on the chat's stream: it is live, and the next loss
     * waits the shortest delay again. Returns whether it had been lost.
     */
    receiving(chatId: string) {
      const state = states.get(chatId);
      if (!state) return false;
      state.delay = MIN_FOLLOW_RETRY_MS;
      const wasLost = state.lost;
      state.lost = false;
      return wasLost;
    },

    /** The chat's session is gone: nothing more is followed for it. */
    forget(chatId: string) {
      const state = states.get(chatId);
      if (state) {
        cancelRetry(state);
        cancelEnding(state);
      }
      states.delete(chatId);
      pending.delete(chatId);
    },
  };
};
