import {
  getShortcutAction,
  RESERVED_SHORTCUTS,
  type ReservedShortcutId,
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
} from "./actions";
import {
  type Chord,
  chordId,
  type KeyPlatform,
  parseChord,
  serializeChord,
} from "./chord";

/**
 * What the user changed, by action id: a chord string, or `null` for
 * "no shortcut". Actions not listed use their default, so improving a default
 * reaches everyone who never touched it.
 */
export type KeybindingOverrides = Readonly<Record<string, string | null>>;

const parsedChordCache = new Map<string, Chord | null>();

const parseCached = (text: string): Chord | null => {
  let chord = parsedChordCache.get(text);
  if (chord === undefined) {
    chord = parseChord(text);
    parsedChordCache.set(text, chord);
  }
  return chord;
};

export const getDefaultBinding = (
  id: ShortcutActionId,
  platform: KeyPlatform,
): Chord | null => {
  const text = getShortcutAction(id)?.defaults[platform] ?? null;
  return text === null ? null : parseCached(text);
};

/**
 * The chord an action answers to. An override that no longer parses (edited
 * by hand, or from a newer version) falls back to the default.
 */
export const getEffectiveBinding = (
  id: ShortcutActionId,
  overrides: KeybindingOverrides,
  platform: KeyPlatform,
): Chord | null => {
  if (!Object.hasOwn(overrides, id)) {
    return getDefaultBinding(id, platform);
  }
  const override = overrides[id];
  if (override === null || override === undefined) {
    return null;
  }
  return parseCached(override) ?? getDefaultBinding(id, platform);
};

export const isBindingCustomized = (
  id: ShortcutActionId,
  overrides: KeybindingOverrides,
  platform: KeyPlatform,
): boolean => {
  const effective = getEffectiveBinding(id, overrides, platform);
  const fallback = getDefaultBinding(id, platform);
  if (effective === null || fallback === null) {
    return effective !== fallback;
  }
  return chordId(effective, platform) !== chordId(fallback, platform);
};

/**
 * Chord id → action, for the dispatcher. When two actions share a chord
 * (only possible through a hand-edited profile), the first one listed wins.
 */
export const buildChordIndex = (
  overrides: KeybindingOverrides,
  platform: KeyPlatform,
): Map<string, ShortcutActionId> => {
  const index = new Map<string, ShortcutActionId>();
  for (const action of SHORTCUT_ACTIONS) {
    const chord = getEffectiveBinding(action.id, overrides, platform);
    if (!chord) {
      continue;
    }
    const key = chordId(chord, platform);
    if (!index.has(key)) {
      index.set(key, action.id);
    }
  }
  return index;
};

const reservedIndexByPlatform = new Map<
  KeyPlatform,
  Map<string, ReservedShortcutId>
>();

const getReservedIndex = (platform: KeyPlatform) => {
  let index = reservedIndexByPlatform.get(platform);
  if (!index) {
    index = new Map();
    for (const reserved of RESERVED_SHORTCUTS) {
      for (const text of reserved.chords[platform]) {
        const chord = parseChord(text);
        if (chord) {
          index.set(chordId(chord, platform), reserved.id);
        }
      }
    }
    reservedIndexByPlatform.set(platform, index);
  }
  return index;
};

export type ChordOwner =
  | { id: ShortcutActionId; kind: "action" }
  | { id: ReservedShortcutId; kind: "reserved" };

/**
 * Who already answers to `chord`, ignoring `exceptId` (the action being
 * edited). Reserved keys come first: they can never be reassigned.
 */
export const findChordOwner = (
  chord: Chord,
  overrides: KeybindingOverrides,
  platform: KeyPlatform,
  exceptId?: ShortcutActionId,
): ChordOwner | null => {
  const key = chordId(chord, platform);

  const reserved = getReservedIndex(platform).get(key);
  if (reserved) {
    return { id: reserved, kind: "reserved" };
  }

  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === exceptId) {
      continue;
    }
    const bound = getEffectiveBinding(action.id, overrides, platform);
    if (bound && chordId(bound, platform) === key) {
      return { id: action.id, kind: "action" };
    }
  }
  return null;
};

const withBinding = (
  overrides: KeybindingOverrides,
  id: ShortcutActionId,
  chord: Chord | null,
  platform: KeyPlatform,
): Record<string, string | null> => {
  const next: Record<string, string | null> = { ...overrides };
  const fallback = getDefaultBinding(id, platform);
  const isDefault =
    chord === null
      ? fallback === null
      : fallback !== null &&
        chordId(chord, platform) === chordId(fallback, platform);

  // Only differences from the default are stored.
  if (isDefault) {
    delete next[id];
  } else {
    next[id] = chord === null ? null : serializeChord(chord);
  }
  return next;
};

/**
 * Binds `id` to `chord` (or unbinds it with `null`). Any other action that
 * had the same chord loses it, so one chord never means two things.
 */
export const assignBinding = (
  overrides: KeybindingOverrides,
  id: ShortcutActionId,
  chord: Chord | null,
  platform: KeyPlatform,
): Record<string, string | null> => {
  let next = withBinding(overrides, id, chord, platform);
  if (!chord) {
    return next;
  }

  const key = chordId(chord, platform);
  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === id) {
      continue;
    }
    const bound = getEffectiveBinding(action.id, next, platform);
    if (bound && chordId(bound, platform) === key) {
      next = withBinding(next, action.id, null, platform);
    }
  }
  return next;
};

/**
 * Puts `id` back to its default. If another action has since taken that
 * chord, the other action loses it, as with {@link assignBinding}.
 */
export const resetBinding = (
  overrides: KeybindingOverrides,
  id: ShortcutActionId,
  platform: KeyPlatform,
): Record<string, string | null> =>
  assignBinding(overrides, id, getDefaultBinding(id, platform), platform);
