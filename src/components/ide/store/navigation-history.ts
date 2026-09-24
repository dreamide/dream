/**
 * Browser-style back/forward history over where the user is in the app: the
 * active project and the chat focused inside it.
 *
 * Everything here is pure so it can be tested without a store. The store and
 * the subscription that feeds it live in `navigation-history-store.ts`.
 */

export interface NavLocation {
  chatId: string | null;
  projectId: string;
}

export interface NavHistory {
  entries: NavLocation[];
  /** Position of the current location in `entries`, or -1 when empty. */
  index: number;
}

export const MAX_NAV_HISTORY_ENTRIES = 100;

export const EMPTY_NAV_HISTORY: NavHistory = { entries: [], index: -1 };

export const isSameNavLocation = (a: NavLocation, b: NavLocation) =>
  a.projectId === b.projectId && a.chatId === b.chatId;

/**
 * Records a visit to `location`, the way a browser records following a link:
 * anything forward of the current entry is dropped.
 *
 * Two visits collapse into one entry:
 * - the same location again, which is not a move at all;
 * - a project visited before it had a chat, followed by the chat it was given
 *   automatically. Keeping both would make the user press back twice to leave
 *   a project they only switched to once.
 */
export const recordNavLocation = (
  history: NavHistory,
  location: NavLocation,
): NavHistory => {
  const current = history.entries[history.index];

  if (current && isSameNavLocation(current, location)) {
    return history;
  }

  if (
    current &&
    current.projectId === location.projectId &&
    current.chatId === null
  ) {
    const entries = [...history.entries];
    entries[history.index] = location;
    return { entries, index: history.index };
  }

  const entries = [...history.entries.slice(0, history.index + 1), location];
  const overflow = Math.max(0, entries.length - MAX_NAV_HISTORY_ENTRIES);
  const trimmed = overflow > 0 ? entries.slice(overflow) : entries;

  return { entries: trimmed, index: trimmed.length - 1 };
};

/**
 * Replaces the current entry without moving. Used when going back or forward
 * lands somewhere slightly different from the entry, for example because the
 * chat could not be focused, so the history keeps describing where the user
 * actually is.
 */
export const replaceCurrentNavLocation = (
  history: NavHistory,
  location: NavLocation,
): NavHistory => {
  const current = history.entries[history.index];
  if (!current || isSameNavLocation(current, location)) {
    return history;
  }

  const entries = [...history.entries];
  entries[history.index] = location;
  return { entries, index: history.index };
};

/**
 * Drops entries the user can no longer go to (a closed project, a deleted
 * chat), then merges neighbours that became identical once the entry between
 * them was removed. The current position stays on the same entry, or on the
 * nearest surviving one before it.
 *
 * Returns the same object when nothing was removed, so callers can skip a
 * store update.
 */
export const pruneNavHistory = (
  history: NavHistory,
  isValid: (location: NavLocation) => boolean,
): NavHistory => {
  const entries: NavLocation[] = [];
  let index = -1;

  history.entries.forEach((entry, position) => {
    if (isValid(entry)) {
      const previous = entries[entries.length - 1];
      if (!previous || !isSameNavLocation(previous, entry)) {
        entries.push(entry);
      }
    }

    if (position <= history.index) {
      index = entries.length - 1;
    }
  });

  if (entries.length === history.entries.length) {
    return history;
  }

  // When everything up to the current position was removed, land on the first
  // entry that survived rather than on nothing.
  return { entries, index: entries.length > 0 ? Math.max(0, index) : -1 };
};

export const canGoBackInNavHistory = (history: NavHistory) => history.index > 0;

export const canGoForwardInNavHistory = (history: NavHistory) =>
  history.index >= 0 && history.index < history.entries.length - 1;

/** Moves one step back (-1) or forward (1), or returns null at either end. */
export const stepNavHistory = (
  history: NavHistory,
  direction: -1 | 1,
): NavHistory | null => {
  const canMove =
    direction < 0
      ? canGoBackInNavHistory(history)
      : canGoForwardInNavHistory(history);

  return canMove ? { ...history, index: history.index + direction } : null;
};
