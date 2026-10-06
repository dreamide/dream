import { useCallback, useEffect, useRef } from "react";
import {
  buildChordIndex,
  type Chord,
  type ChordEventLike,
  chordFromEvent,
  chordId,
  getEffectiveBinding,
  isTerminalPassthroughChord,
  isTextEditingChord,
  type KeybindingOverrides,
  type KeyPlatform,
  type ShortcutActionId,
} from "@/lib/keybindings";
import { isAnyModalOpen } from "@/lib/modal-visibility";
import { useIdeStore } from "../ide-store";

// One window keydown listener resolves every app shortcut. Components say
// what an action does with `useShortcut`; the user's bindings decide which
// keys trigger it, so no component spells out a key itself.

type ShortcutHandler = (event: KeyboardEvent) => void;

interface HandlerEntry {
  handlerRef: { current: ShortcutHandler };
}

/** Per action, every enabled handler; the most recently enabled one runs. */
const handlersByAction = new Map<ShortcutActionId, HandlerEntry[]>();

let chordIndexCache: {
  index: Map<string, ShortcutActionId>;
  overrides: KeybindingOverrides;
  platform: KeyPlatform;
} | null = null;

const getChordIndex = (
  overrides: KeybindingOverrides,
  platform: KeyPlatform,
) => {
  if (
    chordIndexCache?.overrides !== overrides ||
    chordIndexCache.platform !== platform
  ) {
    chordIndexCache = {
      index: buildChordIndex(overrides, platform),
      overrides,
      platform,
    };
  }
  return chordIndexCache.index;
};

const getKeyPlatform = (): KeyPlatform =>
  useIdeStore.getState().isMacOs ? "mac" : "other";

export const useKeyPlatform = (): KeyPlatform =>
  useIdeStore((state) => (state.isMacOs ? "mac" : "other"));

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  target.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  ) !== null;

/** The action a keydown event triggers, if any. */
const resolveEventAction = (
  event: KeyboardEvent,
): { chord: Chord; id: ShortcutActionId; platform: KeyPlatform } | null => {
  const platform = getKeyPlatform();
  const chord = chordFromEvent(event, platform);
  if (!chord) {
    return null;
  }
  const overrides = useIdeStore.getState().settings.keybindings ?? {};
  const id = getChordIndex(overrides, platform).get(chordId(chord, platform));
  return id ? { chord, id, platform } : null;
};

const handleWindowKeyDown = (event: KeyboardEvent) => {
  // Something closer to the focus (the code editor, the terminal, a menu,
  // the shortcut recorder) already handled it.
  if (event.defaultPrevented || event.isComposing || isAnyModalOpen()) {
    return;
  }

  const match = resolveEventAction(event);
  if (!match) {
    return;
  }
  if (
    isEditableTarget(event.target) &&
    isTextEditingChord(match.chord, match.platform)
  ) {
    return;
  }

  const entry = handlersByAction.get(match.id)?.at(-1);
  if (!entry) {
    return;
  }

  event.preventDefault();
  // Holding the keys down runs the action once.
  if (event.repeat) {
    return;
  }
  entry.handlerRef.current(event);
};

/** Installs the window listener. Mount once, at the app shell. */
export const useShortcutDispatcher = () => {
  useEffect(() => {
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => window.removeEventListener("keydown", handleWindowKeyDown);
  }, []);
};

/**
 * Runs `handler` when the user's shortcut for `id` is pressed, while
 * `enabled`. When several components handle one action (one per mounted
 * project, say), only enable it where it applies.
 */
export const useShortcut = (
  id: ShortcutActionId,
  handler: ShortcutHandler,
  enabled = true,
) => {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const entry: HandlerEntry = { handlerRef };
    const entries = handlersByAction.get(id) ?? [];
    handlersByAction.set(id, [...entries, entry]);
    return () => {
      const remaining = (handlersByAction.get(id) ?? []).filter(
        (candidate) => candidate !== entry,
      );
      if (remaining.length > 0) {
        handlersByAction.set(id, remaining);
      } else {
        handlersByAction.delete(id);
      }
    };
  }, [enabled, id]);
};

/** The chord currently bound to `id`, or `null` when it has none. */
export const useShortcutBinding = (id: ShortcutActionId): Chord | null => {
  const platform = useKeyPlatform();
  const overrides = useIdeStore((state) => state.settings.keybindings);
  return getEffectiveBinding(id, overrides ?? {}, platform);
};

/**
 * A predicate for a keydown handled locally (in an element's own
 * `onKeyDown`) rather than through the window dispatcher, such as Save in the
 * file editor.
 */
export const useShortcutMatcher = (id: ShortcutActionId) => {
  const binding = useShortcutBinding(id);
  const platform = useKeyPlatform();
  return useCallback(
    (event: ChordEventLike) => {
      if (!binding) {
        return false;
      }
      const chord = chordFromEvent(event, platform);
      return (
        chord !== null &&
        chordId(chord, platform) === chordId(binding, platform)
      );
    },
    [binding, platform],
  );
};

/**
 * For the terminal's key handler: whether this keydown is an app shortcut
 * the terminal should let through instead of sending it to the shell.
 */
export const isAppShortcutForTerminal = (event: KeyboardEvent): boolean => {
  if (event.type !== "keydown") {
    return false;
  }
  const match = resolveEventAction(event);
  return (
    match !== null &&
    handlersByAction.has(match.id) &&
    isTerminalPassthroughChord(match.chord, match.platform)
  );
};
