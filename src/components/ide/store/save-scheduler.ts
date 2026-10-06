/**
 * When the store saves, and what: the persisted parts of the state are
 * grouped into slices, a change marks its slice dirty, and a save some
 * 300 ms after the last change (in an idle moment, at most ~2 s later)
 * sends the dirty slices only. `flush` saves now (an explicit persist, a
 * closing window).
 *
 *   config        active project, app view, chat sort, browser tabs, settings
 *   savedPrompts  saved prompts
 *   projects      open and closed projects (their rows, their catalog)
 *   chats         chats (their catalog, and the project rows they settle)
 *
 * Changes made before the state is hydrated are the load itself and mark
 * nothing.
 *
 * Pure: the timers are passed in, so it is tested without React or time.
 */

export type SaveSlice = "chats" | "config" | "projects" | "savedPrompts";

/** The persisted fields of the store, by slice. */
export const SAVE_SLICE_FIELDS = {
  chats: ["chats"],
  config: [
    "activeBrowserTabIdByProject",
    "activeProjectId",
    "appView",
    "browserTabsByProject",
    "chatSort",
    "settings",
  ],
  projects: ["closedProjects", "projects"],
  savedPrompts: ["savedPrompts"],
} as const satisfies Record<SaveSlice, readonly string[]>;

type SavedFields = {
  [Slice in SaveSlice]: (typeof SAVE_SLICE_FIELDS)[Slice][number];
}[SaveSlice];

export type SchedulerState = { stateHydrated: boolean } & Record<
  SavedFields,
  unknown
>;

export interface SaveTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Runs `callback` when the thread is idle, or by `timeoutMs`. */
  whenIdle?: (callback: () => void, timeoutMs: number) => unknown;
  cancelIdle?: (handle: unknown) => void;
}

const SLICES = Object.keys(SAVE_SLICE_FIELDS) as SaveSlice[];

export const createSaveScheduler = ({
  delayMs = 300,
  idleTimeoutMs = 2000,
  save,
  timers,
}: {
  delayMs?: number;
  idleTimeoutMs?: number;
  /** Saves the dirty slices (never empty). */
  save: (dirty: ReadonlySet<SaveSlice>) => void;
  timers: SaveTimers;
}) => {
  const dirty = new Set<SaveSlice>();
  let timer: unknown = null;
  let idle: unknown = null;

  const cancel = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (idle !== null) {
      timers.cancelIdle?.(idle);
      idle = null;
    }
  };

  const flush = () => {
    cancel();
    if (dirty.size === 0) return;
    const slices = new Set(dirty);
    dirty.clear();
    save(slices);
  };

  const schedule = () => {
    cancel();
    timer = timers.setTimeout(() => {
      timer = null;
      // Encoding for a save costs the renderer thread; wait for an idle
      // moment so it never lands mid-animation, but save within the timeout.
      if (timers.whenIdle) {
        idle = timers.whenIdle(() => {
          idle = null;
          flush();
        }, idleTimeoutMs);
      } else {
        flush();
      }
    }, delayMs);
  };

  return {
    /** A store listener: marks the slices whose fields changed. */
    observe: (state: SchedulerState, previous: SchedulerState) => {
      if (!state.stateHydrated || !previous.stateHydrated) return;
      let changed = false;
      for (const slice of SLICES) {
        if (
          SAVE_SLICE_FIELDS[slice].some(
            (field) => state[field] !== previous[field],
          )
        ) {
          dirty.add(slice);
          changed = true;
        }
      }
      if (changed) schedule();
    },

    /** Saves whatever is dirty now. */
    flush,

    /**
     * Saves every slice now: an explicit persist, which may follow a change
     * that is not a field's (a host's catalog just loaded). Only what
     * differs from the last save is sent, so this costs no more than that.
     */
    saveAll: () => {
      for (const slice of SLICES) dirty.add(slice);
      flush();
    },

    /** The slices waiting to be saved. */
    pending: (): ReadonlySet<SaveSlice> => new Set(dirty),

    /** Stops any scheduled save without saving. */
    dispose: () => {
      cancel();
      dirty.clear();
    },
  };
};

/** The renderer's timers: setTimeout and requestIdleCallback. */
export const browserSaveTimers = (): SaveTimers => ({
  cancelIdle: (handle) => cancelIdleCallback(handle as number),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  ...(typeof requestIdleCallback === "function"
    ? {
        whenIdle: (callback: () => void, timeoutMs: number) =>
          requestIdleCallback(callback, { timeout: timeoutMs }),
      }
    : {}),
});
