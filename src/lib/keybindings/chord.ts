/**
 * A key chord: modifiers plus one key, e.g. `Mod+Shift+F`.
 *
 * `Mod` is the platform's command modifier: Cmd on macOS, Ctrl elsewhere.
 * `Ctrl` is the physical Control key, and only differs from `Mod` on macOS;
 * on Windows and Linux a chord with `Ctrl` is the same chord as one with
 * `Mod`. Storing `Mod` rather than a concrete key keeps one binding correct
 * on every platform.
 */
export interface Chord {
  alt: boolean;
  ctrl: boolean;
  /** Canonical key name; see {@link normalizeKeyName}. */
  key: string;
  mod: boolean;
  shift: boolean;
}

export type KeyPlatform = "mac" | "other";

/** What a chord-producing keyboard event exposes. */
export interface ChordEventLike {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  getModifierState?: (key: string) => boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

const NAMED_KEYS = [
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backspace",
  "Delete",
  "End",
  "Enter",
  "Escape",
  "Home",
  "Insert",
  "PageDown",
  "PageUp",
  "Space",
  "Tab",
] as const;

const NAMED_KEY_BY_LOWER = new Map<string, string>(
  NAMED_KEYS.map((key) => [key.toLowerCase(), key]),
);

const PUNCTUATION_KEYS = new Set([
  "`",
  "-",
  "=",
  "[",
  "]",
  "\\",
  ";",
  "'",
  ",",
  ".",
  "/",
]);

/**
 * Physical keys read by position rather than by the character they type, so
 * Shift (`[` types `{`) and non-US layouts do not change the chord.
 */
const KEY_BY_CODE: Record<string, string> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: "Space",
};

const MODIFIER_KEY_NAMES = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
]);

const FUNCTION_KEY_PATTERN = /^F([1-9]|1[0-9]|2[0-4])$/;

/**
 * The canonical spelling of a key name, or `null` when it is not a key a
 * chord can end on. Letters are lower case (`f`), named keys are in
 * `KeyboardEvent.key` spelling (`ArrowLeft`), function keys are `F1`–`F24`.
 */
export const normalizeKeyName = (value: string): string | null => {
  if (value.length === 1) {
    const lower = value.toLowerCase();
    if (/^[a-z0-9]$/.test(lower) || PUNCTUATION_KEYS.has(value)) {
      return lower;
    }
    return value === " " ? "Space" : null;
  }

  const upper = value.toUpperCase();
  if (FUNCTION_KEY_PATTERN.test(upper)) {
    return upper;
  }

  return NAMED_KEY_BY_LOWER.get(value.toLowerCase()) ?? null;
};

/** Parses `Mod+Shift+F` (any case, any modifier order); `null` if invalid. */
export const parseChord = (text: string): Chord | null => {
  if (typeof text !== "string" || text.trim() === "") {
    return null;
  }

  // `+` itself cannot be a key, so splitting on it is unambiguous.
  const parts = text.split("+").map((part) => part.trim());
  const keyPart = parts.pop();
  if (!keyPart) {
    return null;
  }

  const key = normalizeKeyName(keyPart);
  if (!key) {
    return null;
  }

  const chord: Chord = {
    alt: false,
    ctrl: false,
    key,
    mod: false,
    shift: false,
  };

  for (const part of parts) {
    switch (part.toLowerCase()) {
      case "mod":
      case "cmdorctrl":
        chord.mod = true;
        break;
      case "ctrl":
      case "control":
        chord.ctrl = true;
        break;
      case "alt":
      case "option":
        chord.alt = true;
        break;
      case "shift":
        chord.shift = true;
        break;
      default:
        return null;
    }
  }

  return chord;
};

/** The canonical text form: `Mod+Ctrl+Alt+Shift+key`. */
export const serializeChord = (chord: Chord): string =>
  [
    chord.mod ? "Mod" : null,
    chord.ctrl ? "Ctrl" : null,
    chord.alt ? "Alt" : null,
    chord.shift ? "Shift" : null,
    chord.key,
  ]
    .filter(Boolean)
    .join("+");

/**
 * The chord as it behaves on `platform`. Off macOS, Ctrl and Mod are the same
 * key, so `Ctrl` folds into `Mod`.
 */
export const canonicalizeChord = (
  chord: Chord,
  platform: KeyPlatform,
): Chord =>
  platform === "mac"
    ? chord
    : { ...chord, ctrl: false, mod: chord.mod || chord.ctrl };

export const chordsEqual = (
  left: Chord,
  right: Chord,
  platform: KeyPlatform,
): boolean => {
  const a = canonicalizeChord(left, platform);
  const b = canonicalizeChord(right, platform);
  return (
    a.key === b.key &&
    a.mod === b.mod &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift
  );
};

/** A string key two chords share exactly when they are equal on `platform`. */
export const chordId = (chord: Chord, platform: KeyPlatform): string =>
  serializeChord(canonicalizeChord(chord, platform));

const keyFromEvent = (event: ChordEventLike): string | null => {
  if (MODIFIER_KEY_NAMES.has(event.key)) {
    return null;
  }

  const code = event.code ?? "";
  // Digits by position: on AZERTY they need Shift to type, and Shift+1
  // types `!` everywhere.
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (digit) {
    return digit[1] ?? null;
  }

  const byCode = KEY_BY_CODE[code];
  if (byCode) {
    return byCode;
  }

  const fromKey = normalizeKeyName(event.key);
  if (fromKey) {
    return fromKey;
  }

  // Option+letter on macOS types `ƒ`, a dead key types nothing, and
  // non-Latin layouts type their own script: use the key's position.
  const letter = /^Key([A-Z])$/.exec(code);
  return letter?.[1]?.toLowerCase() ?? null;
};

/**
 * The chord a keydown event spells on `platform`, or `null` when the event is
 * a lone modifier, an unsupported key, AltGr typing a character, or uses the
 * Windows/Super key (which the OS owns).
 */
export const chordFromEvent = (
  event: ChordEventLike,
  platform: KeyPlatform,
): Chord | null => {
  if (event.getModifierState?.("AltGraph")) {
    return null;
  }
  if (platform !== "mac" && event.metaKey) {
    return null;
  }

  const key = keyFromEvent(event);
  if (!key) {
    return null;
  }

  return platform === "mac"
    ? {
        alt: event.altKey,
        ctrl: event.ctrlKey,
        key,
        mod: event.metaKey,
        shift: event.shiftKey,
      }
    : {
        alt: event.altKey,
        ctrl: false,
        key,
        mod: event.ctrlKey,
        shift: event.shiftKey,
      };
};

const isLetter = (key: string) => /^[a-z]$/.test(key);

/**
 * Chords a terminal sends to the shell as a control character (Ctrl+C,
 * Ctrl+W, Ctrl+R…). The terminal keeps these; every other app shortcut is
 * passed through to the app, as in VS Code.
 */
export const isShellControlChord = (
  chord: Chord,
  platform: KeyPlatform,
): boolean => {
  const c = canonicalizeChord(chord, platform);
  const control = platform === "mac" ? c.ctrl && !c.mod : c.mod;
  return control && !c.alt && !c.shift && isLetter(c.key);
};

/**
 * Whether a terminal hands this chord to the app instead of the shell. Only
 * chords with Mod or Ctrl are candidates (Alt+← and F-keys are the shell's),
 * and of those the shell keeps its control characters.
 */
export const isTerminalPassthroughChord = (
  chord: Chord,
  platform: KeyPlatform,
): boolean => {
  const c = canonicalizeChord(chord, platform);
  return (c.mod || c.ctrl) && !isShellControlChord(c, platform);
};

/**
 * Chords a text field uses to type, move the caret or select: plain and
 * Shift+ keys everywhere, and Option+ keys on macOS (Option+← moves by word).
 * A shortcut on one of these stays out of the way while typing. Windows and
 * Linux move by word with Ctrl, so Alt+← is free there.
 */
export const isTextEditingChord = (
  chord: Chord,
  platform: KeyPlatform,
): boolean => {
  const c = canonicalizeChord(chord, platform);
  if (c.mod || c.ctrl || FUNCTION_KEY_PATTERN.test(c.key)) {
    return false;
  }
  return platform === "mac" || !c.alt;
};

export type ChordProblem = "needsModifier";

/**
 * Why a chord cannot be a shortcut. Anything but a function key needs Mod,
 * Ctrl or Alt; Shift alone just types a capital.
 */
export const getChordProblem = (chord: Chord): ChordProblem | null => {
  if (FUNCTION_KEY_PATTERN.test(chord.key)) {
    return null;
  }
  return chord.mod || chord.ctrl || chord.alt ? null : "needsModifier";
};

const MAC_KEY_SYMBOLS: Record<string, string> = {
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  Backspace: "⌫",
  Delete: "⌦",
  End: "↘",
  Enter: "↩",
  Escape: "⎋",
  Home: "↖",
  PageDown: "⇟",
  PageUp: "⇞",
  Space: "Space",
  Tab: "⇥",
};

const OTHER_KEY_LABELS: Record<string, string> = {
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  Delete: "Del",
  Escape: "Esc",
  Insert: "Ins",
  PageDown: "PgDn",
  PageUp: "PgUp",
};

const formatKey = (key: string, platform: KeyPlatform): string => {
  const labels = platform === "mac" ? MAC_KEY_SYMBOLS : OTHER_KEY_LABELS;
  return labels[key] ?? (key.length === 1 ? key.toUpperCase() : key);
};

/**
 * The chord as key caps, in each platform's own order and spelling:
 * `["⌃", "⇧", "⌘", "F"]` on macOS, `["Ctrl", "Shift", "F"]` elsewhere.
 */
export const formatChordParts = (
  chord: Chord,
  platform: KeyPlatform,
): string[] => {
  const c = canonicalizeChord(chord, platform);
  const key = formatKey(c.key, platform);

  if (platform === "mac") {
    return [
      c.ctrl ? "⌃" : null,
      c.alt ? "⌥" : null,
      c.shift ? "⇧" : null,
      c.mod ? "⌘" : null,
      key,
    ].filter((part): part is string => part !== null);
  }

  return [
    c.mod ? "Ctrl" : null,
    c.alt ? "Alt" : null,
    c.shift ? "Shift" : null,
    key,
  ].filter((part): part is string => part !== null);
};

/** One-line form for tooltips: `⇧⌘F` on macOS, `Ctrl+Shift+F` elsewhere. */
export const formatChord = (chord: Chord, platform: KeyPlatform): string =>
  formatChordParts(chord, platform).join(platform === "mac" ? "" : "+");
