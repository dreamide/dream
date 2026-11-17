// The turn lifetime.
//
// What a Provider adapter that keeps a process or server for its turn needs
// to end that turn exactly once, however it ends: the provider says it is
// done, it fails, or Stop aborts the turn's signal. `streamAgentTurn` makes
// one per Agent turn and hands it to the adapter's `execute`; the adapter
// keeps its translation and its own interrupt request, and stops keeping a
// settle-once flag or an abort listener of its own.
//
//   life.signal / life.aborted     the turn's abort signal (Stop)
//   life.onAbort(fn)               runs fn once on Stop, at once if Stop
//                                  already happened; never after the end
//   life.defer(cleanup)            runs once when the turn ends, in reverse
//                                  order; at once if it already ended
//   life.done(value) / fail(error) end the turn; the first one wins
//   life.ended                     whether it ended (late-start guards)
//   life.settled                   settles when it ends
//
// Stop does not end a turn by itself: the adapter's `onAbort` decides,
// because some providers confirm an interrupt first (Codex's
// `turn/interrupt`, ACP's `session/cancel`). A client that stops reading
// the response does not abort the signal at all (turn-registry.js).

/**
 * @param {AbortSignal | undefined} signal The turn's own signal.
 */
export const createTurnLifetime = (signal) => {
  let ended = false;
  /** @type {Array<() => void>} */
  let abortHandlers = [];
  /** @type {Array<() => void>} */
  const cleanups = [];
  /** @type {(value: unknown) => void} */
  let resolveSettled = () => {};
  /** @type {(error: unknown) => void} */
  let rejectSettled = () => {};
  const settled = new Promise((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });

  const runCleanup = (cleanup) => {
    try {
      cleanup();
    } catch (error) {
      console.error("[turn] A turn cleanup failed.", error);
    }
  };

  const end = (settle) => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener("abort", handleAbort);
    abortHandlers = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      runCleanup(cleanup);
    }
    settle();
  };

  /** Ends the turn with `value`. Later endings are ignored. */
  const done = (value) => {
    end(() => resolveSettled(value));
  };

  /** Ends the turn with `error`. Later endings are ignored. */
  const fail = (error) => {
    end(() => rejectSettled(error));
  };

  // A handler that throws fails the turn rather than the abort event.
  const runAbortHandler = (handler) => {
    if (ended) return;
    try {
      handler();
    } catch (error) {
      fail(error);
    }
  };

  function handleAbort() {
    const handlers = abortHandlers;
    abortHandlers = [];
    for (const handler of handlers) runAbortHandler(handler);
  }

  signal?.addEventListener("abort", handleAbort, { once: true });

  return {
    signal,
    get aborted() {
      return signal?.aborted === true;
    },
    get ended() {
      return ended;
    },
    settled,
    /** @param {() => void} handler */
    onAbort: (handler) => {
      if (ended) return;
      if (signal?.aborted) {
        runAbortHandler(handler);
        return;
      }
      abortHandlers.push(handler);
    },
    /** @param {() => void} cleanup */
    defer: (cleanup) => {
      if (ended) {
        runCleanup(cleanup);
        return;
      }
      cleanups.push(cleanup);
    },
    done,
    fail,
    /**
     * Runs the adapter's `start` and answers `settled`. The promise `start`
     * returns ends the turn when it settles, so an adapter written as one
     * async body ends with it; an adapter driven by callbacks returns
     * `settled` and ends the turn with `done` or `fail`.
     * @param {() => unknown} start
     */
    run: (start) => {
      let started;
      try {
        started = start();
      } catch (error) {
        started = Promise.reject(error);
      }
      Promise.resolve(started).then(done, fail);
      return settled;
    },
  };
};
