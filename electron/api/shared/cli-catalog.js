// What the host knows about the agent CLIs on this machine: whether a
// command is here, where, and which version, held in one cache with one
// policy.
//
//   a fact that was found     kept for `ttlMs` (5 minutes)
//   a fact that was not       kept for `missTtlMs` (30 seconds), so a CLI
//                             installed meanwhile shows up soon
//   a read under way          shared by everyone who asks during it
//   a read that threw         not kept
//   `force`                   reads again now (a user's explicit refresh)
//   `forget(command)`         drops what is known about a command: after an
//                             upgrade, or when starting it failed
//
// On Windows every lookup is a PowerShell process, and a turn used to make
// two of them before it started; now a turn asks this cache.
//
// Pure: the readers are passed in, so tests count what is read.

/**
 * One timed cache: the policy above for any keyed read.
 * @param {{ ttlMs: number, missTtlMs?: number, now?: () => number,
 *   isMiss?: (value: unknown) => boolean }} options
 */
export const createTimedCache = ({
  ttlMs,
  missTtlMs = ttlMs,
  now = Date.now,
  isMiss = (value) => value === null || value === undefined,
}) => {
  /** @type {Map<string, { at: number, promise: Promise<unknown>, settled: boolean, value?: unknown }>} */
  const entries = new Map();

  const isCurrent = (entry) => {
    if (!entry.settled) return true;
    const age = now() - entry.at;
    return age < (isMiss(entry.value) ? missTtlMs : ttlMs);
  };

  return {
    /**
     * @template T
     * @param {string} key
     * @param {() => Promise<T>} read
     * @param {{ force?: boolean }} [options]
     * @returns {Promise<T>}
     */
    get(key, read, { force = false } = {}) {
      const existing = entries.get(key);
      if (existing && !force && isCurrent(existing)) {
        return /** @type {Promise<T>} */ (existing.promise);
      }
      const entry = { at: now(), promise: read(), settled: false };
      entries.set(key, entry);
      entry.promise.then(
        (value) => {
          entry.settled = true;
          entry.value = value;
          entry.at = now();
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        },
      );
      return entry.promise;
    },

    /** Drops every key `matches` accepts (all of them by default). */
    forget(matches = () => true) {
      for (const key of [...entries.keys()]) {
        if (matches(key)) entries.delete(key);
      }
    },
  };
};

export const CLI_FOUND_TTL_MS = 5 * 60 * 1000;
export const CLI_MISSING_TTL_MS = 30 * 1000;

/**
 * @param {{
 *   resolvePath: (command: string) => Promise<string | null>,
 *   readVersion: (command: string, commandPath: string) => Promise<string | null>,
 *   now?: () => number,
 * }} readers
 *   `resolvePath`: where `command` is (null: not installed).
 *   `readVersion`: what `<commandPath> --version` says (null: nothing).
 */
export const createCliCatalog = ({ now, readVersion, resolvePath }) => {
  const cache = createTimedCache({
    missTtlMs: CLI_MISSING_TTL_MS,
    now,
    ttlMs: CLI_FOUND_TTL_MS,
  });

  const catalog = {
    /** Where `command` is, or null when it is not installed. */
    path: (command, { force = false } = {}) =>
      cache.get(`path\0${command}`, () => resolvePath(command), { force }),

    /** Whether `command` is installed. */
    isAvailable: async (command, options) =>
      (await catalog.path(command, options)) !== null,

    /** What `command --version` says, or null when it is not installed. */
    version: (command, { force = false } = {}) =>
      cache.get(
        `version\0${command}`,
        async () => {
          const commandPath = await catalog.path(command, { force });
          return commandPath ? readVersion(command, commandPath) : null;
        },
        { force },
      ),

    /**
     * A fact derived from the CLIs (which of several binaries is Cursor's),
     * under the same policy.
     * @template T
     * @param {string} name
     * @param {() => Promise<T>} read
     * @param {{ force?: boolean }} [options]
     */
    derived: (name, read, options) =>
      cache.get(`derived\0${name}`, read, options),

    /**
     * Forgets what is known about `command` (every command by default) and
     * every derived fact, which may have rested on it.
     */
    forget: (command) =>
      cache.forget(
        (key) =>
          !command ||
          key.startsWith("derived\0") ||
          key === `path\0${command}` ||
          key === `version\0${command}`,
      ),
  };
  return catalog;
};
