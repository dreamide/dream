/**
 * Project resources: what a client reads about one project on one host
 * (its git status, branches, worktrees, log, pull request context, file
 * list), held in one cache that owns their keys, sharing and freshness.
 *
 * Freshness comes from outside: `getVersion(scope, group)` is the
 * project's current version of a group of resources (the store's refresh
 * keys), and an entry fetched at an older version is stale. When a
 * version moves, `invalidate` tells the entries in that group; those with
 * a subscriber that is showing them (`active`) are fetched again at once,
 * the rest when one of their subscribers next becomes active.
 *
 * Reads share: a read at a version joins one already under way at that
 * version, and a read that another entry can answer (a summary from a full
 * status, a short file list from a longer one) is taken from it.
 *
 * Pure: the loader and the version source are passed in, so it runs with a
 * fake Route client in tests.
 */

/** Which project a resource belongs to: one path on one host. */
export interface ProjectScope {
  hostId: string;
  projectPath: string;
}

/** Resources a version covers, invalidated together. */
export type ResourceGroup = "files" | "git";

export type ResourceParams = Record<string, boolean | number | string>;

export interface ResourceKey<Kind extends string = string>
  extends ProjectScope {
  kind: Kind;
  params?: ResourceParams;
}

// Methods, not function properties, so a spec for one kind's data is a
// spec of the cache's (unknown) data.
export interface ResourceSpec<Data = unknown> {
  group: ResourceGroup;
  load(key: ResourceKey): Promise<Data>;
  /**
   * Whether data read with `have` answers a read for `want`, and how:
   * `serve` turns it into the answer.
   */
  serves?(have: ResourceParams, want: ResourceParams): boolean;
  serve?(data: Data, want: ResourceParams): Data;
  /**
   * An answer younger than this stays fresh when its version moves. For
   * resources a version bump rarely changes (pull request context).
   */
  minAgeMs?: number;
}

export interface ResourceSnapshot<Data = unknown> {
  data: Data | undefined;
  error: unknown;
  /** Fetched at the current version (or young enough, see `minAgeMs`). */
  fresh: boolean;
  loading: boolean;
  /** The version the data or error was read at; null before any read. */
  version: number | null;
}

interface Entry {
  activeCount: number;
  data: unknown;
  error: unknown;
  fetchedAt: number;
  id: string;
  key: ResourceKey;
  listeners: Set<() => void>;
  /** The read under way and the version it was started at. */
  pending: { promise: Promise<unknown>; version: number } | null;
  snapshot: ResourceSnapshot;
  version: number | null;
}

const EMPTY_PARAMS: ResourceParams = {};

const scopeId = ({ hostId, projectPath }: ProjectScope) =>
  `${hostId}\0${projectPath.trim()}`;

const entryId = (key: ResourceKey) =>
  `${scopeId(key)}\0${key.kind}\0${JSON.stringify(
    Object.entries(key.params ?? EMPTY_PARAMS).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  )}`;

export const createProjectResourceCache = <Kind extends string>({
  getVersion,
  now = Date.now,
  specs,
}: {
  getVersion: (scope: ProjectScope, group: ResourceGroup) => number;
  now?: () => number;
  specs: Record<Kind, ResourceSpec>;
}) => {
  const entries = new Map<string, Entry>();

  const specOf = (key: ResourceKey): ResourceSpec => specs[key.kind as Kind];

  const currentVersion = (key: ResourceKey) =>
    getVersion(key, specOf(key).group);

  const isFresh = (entry: Entry) => {
    if (entry.version === null) return false;
    if (entry.version === currentVersion(entry.key)) return true;
    const { minAgeMs } = specOf(entry.key);
    return minAgeMs !== undefined && now() - entry.fetchedAt < minAgeMs;
  };

  const entryOf = (key: ResourceKey) => {
    const id = entryId(key);
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        activeCount: 0,
        data: undefined,
        error: undefined,
        fetchedAt: 0,
        id,
        key: { ...key, projectPath: key.projectPath.trim() },
        listeners: new Set(),
        pending: null,
        snapshot: {
          data: undefined,
          error: undefined,
          fresh: false,
          loading: false,
          version: null,
        },
        version: null,
      };
      entries.set(id, entry);
    }
    return entry;
  };

  /**
   * Re-derives the snapshot; tells listeners when it changed, unless
   * `notify` is false (a read during render).
   */
  const publish = (entry: Entry, notify = true) => {
    const next: ResourceSnapshot = {
      data: entry.data,
      error: entry.error,
      fresh: isFresh(entry),
      loading: entry.pending !== null,
      version: entry.version,
    };
    const previous = entry.snapshot;
    if (
      previous.data === next.data &&
      previous.error === next.error &&
      previous.fresh === next.fresh &&
      previous.loading === next.loading &&
      previous.version === next.version
    ) {
      return;
    }
    entry.snapshot = next;
    if (!notify) return;
    for (const listener of entry.listeners) listener();
  };

  /** Another entry, fresh or being read now, that can answer `entry`. */
  const findSource = (entry: Entry, version: number) => {
    const spec = specOf(entry.key);
    if (!spec.serves || !spec.serve) return null;
    const want = entry.key.params ?? EMPTY_PARAMS;
    for (const other of entries.values()) {
      if (
        other === entry ||
        other.key.kind !== entry.key.kind ||
        scopeId(other.key) !== scopeId(entry.key) ||
        !spec.serves(other.key.params ?? EMPTY_PARAMS, want)
      ) {
        continue;
      }
      if (other.pending?.version === version) {
        return other.pending.promise.then((data) =>
          spec.serve ? spec.serve(data, want) : data,
        );
      }
      if (
        other.version === version &&
        other.error === undefined &&
        other.data !== undefined &&
        other.pending === null
      ) {
        return Promise.resolve(spec.serve(other.data, want));
      }
    }
    return null;
  };

  const fetchEntry = (entry: Entry, force: boolean): Promise<unknown> => {
    const version = currentVersion(entry.key);
    if (!force && entry.pending?.version === version) {
      return entry.pending.promise;
    }
    const promise =
      (!force && findSource(entry, version)) ||
      specOf(entry.key).load(entry.key);
    const pending = { promise, version };
    entry.pending = pending;
    publish(entry);
    promise.then(
      (data) => {
        if (entry.pending !== pending) return;
        entry.pending = null;
        entry.data = data;
        entry.error = undefined;
        entry.version = version;
        entry.fetchedAt = now();
        publish(entry);
      },
      (error: unknown) => {
        if (entry.pending !== pending) return;
        entry.pending = null;
        entry.error = error ?? new Error("Request failed.");
        entry.version = version;
        entry.fetchedAt = now();
        publish(entry);
      },
    );
    return promise;
  };

  const cache = {
    /** What is known about `key` now. Stable until it changes. */
    snapshot: (key: ResourceKey): ResourceSnapshot => {
      const entry = entryOf(key);
      // The version may have moved since the last publish; `invalidate`
      // tells the listeners, this only answers.
      publish(entry, false);
      return entry.snapshot;
    },

    /**
     * The data for `key`: fresh data at once, else a read (shared, or
     * served from another entry). `force` reads from the host regardless.
     */
    read: <Data>(key: ResourceKey, { force = false } = {}) => {
      const entry = entryOf(key);
      if (!force && entry.pending === null && isFresh(entry)) {
        return entry.error === undefined
          ? Promise.resolve(entry.data as Data)
          : Promise.reject(entry.error);
      }
      return fetchEntry(entry, force) as Promise<Data>;
    },

    /** Writes data already read elsewhere (e.g. a checkout's answer). */
    set: (key: ResourceKey, data: unknown) => {
      const entry = entryOf(key);
      entry.pending = null;
      entry.data = data;
      entry.error = undefined;
      entry.version = currentVersion(key);
      entry.fetchedAt = now();
      publish(entry);
    },

    /**
     * Follows `key`: `listener` hears every change. An active subscription
     * keeps the data fresh: it reads now if it is not, and again whenever
     * the version moves.
     */
    subscribe: (key: ResourceKey, listener: () => void, active = true) => {
      const entry = entryOf(key);
      entry.listeners.add(listener);
      let isActive = false;
      const setActive = (next: boolean) => {
        if (next === isActive) return;
        isActive = next;
        entry.activeCount += next ? 1 : -1;
        if (next && entry.pending === null && !isFresh(entry)) {
          void fetchEntry(entry, false).catch(() => undefined);
        }
      };
      setActive(active);
      return {
        setActive,
        unsubscribe: () => {
          setActive(false);
          entry.listeners.delete(listener);
        },
      };
    },

    /**
     * The version of `group` for `scope` moved: every entry in it hears so,
     * and those being shown are read again.
     */
    invalidate: (scope: ProjectScope, group: ResourceGroup) => {
      const id = scopeId(scope);
      for (const entry of entries.values()) {
        if (scopeId(entry.key) !== id || specOf(entry.key).group !== group) {
          continue;
        }
        if (entry.activeCount > 0 && !isFresh(entry)) {
          void fetchEntry(entry, false).catch(() => undefined);
        } else {
          publish(entry);
        }
      }
    },

    /**
     * Makes one resource stale whatever its version (something it reports
     * changed without a refresh key moving). Read again at once if shown.
     */
    expire: (key: ResourceKey) => {
      const entry = entries.get(entryId(key));
      if (!entry) return;
      entry.version = entry.version === null ? null : -1;
      entry.fetchedAt = Number.NEGATIVE_INFINITY;
      if (entry.activeCount > 0) {
        // A read already under way may have started before the change.
        void fetchEntry(entry, entry.pending !== null).catch(() => undefined);
      } else {
        entry.pending = null;
        publish(entry);
      }
    },

    /** Drops everything (tests, sign-out). */
    clear: () => entries.clear(),
  };
  return cache;
};

export type ProjectResourceCache = ReturnType<
  typeof createProjectResourceCache
>;
