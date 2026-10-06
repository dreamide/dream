import { describe, expect, it } from "vitest";
import {
  assignBinding,
  buildChordIndex,
  type ChordEventLike,
  chordFromEvent,
  findChordOwner,
  formatChord,
  getChordProblem,
  getEffectiveBinding,
  isBindingCustomized,
  isShellControlChord,
  isTerminalPassthroughChord,
  isTextEditingChord,
  parseChord,
  RESERVED_SHORTCUTS,
  resetBinding,
  SHORTCUT_ACTIONS,
  serializeChord,
} from "./index";

const keyEvent = (
  key: string,
  code: string,
  modifiers: Partial<
    Pick<ChordEventLike, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
  > = {},
): ChordEventLike => ({
  altKey: false,
  code,
  ctrlKey: false,
  key,
  metaKey: false,
  shiftKey: false,
  ...modifiers,
});

const chord = (text: string) => {
  const parsed = parseChord(text);
  if (!parsed) throw new Error(`bad chord ${text}`);
  return parsed;
};

describe("parseChord / serializeChord", () => {
  it("round-trips to a canonical modifier order", () => {
    expect(serializeChord(chord("shift+mod+F"))).toBe("Mod+Shift+f");
    expect(serializeChord(chord("Alt+Ctrl+ArrowLeft"))).toBe(
      "Ctrl+Alt+ArrowLeft",
    );
    expect(serializeChord(chord("Mod+\\"))).toBe("Mod+\\");
    expect(serializeChord(chord("f5"))).toBe("F5");
  });

  it("rejects unknown modifiers, keys and empty input", () => {
    expect(parseChord("")).toBeNull();
    expect(parseChord("Mod+")).toBeNull();
    expect(parseChord("Hyper+K")).toBeNull();
    expect(parseChord("Mod+Shift")).toBeNull();
    expect(parseChord("Mod+é")).toBeNull();
  });
});

describe("chordFromEvent", () => {
  it("reads Cmd as Mod on macOS and Ctrl as Mod elsewhere", () => {
    expect(
      chordFromEvent(keyEvent("f", "KeyF", { metaKey: true }), "mac"),
    ).toEqual(chord("Mod+f"));
    expect(
      chordFromEvent(keyEvent("f", "KeyF", { ctrlKey: true }), "mac"),
    ).toEqual(chord("Ctrl+f"));
    expect(
      chordFromEvent(keyEvent("f", "KeyF", { ctrlKey: true }), "other"),
    ).toEqual(chord("Mod+f"));
  });

  it("ignores lone modifiers, AltGr and the Windows key", () => {
    expect(
      chordFromEvent(keyEvent("Shift", "ShiftLeft", { shiftKey: true }), "mac"),
    ).toBeNull();
    expect(
      chordFromEvent(
        {
          ...keyEvent("@", "KeyQ", { altKey: true, ctrlKey: true }),
          getModifierState: (key) => key === "AltGraph",
        },
        "other",
      ),
    ).toBeNull();
    expect(
      chordFromEvent(keyEvent("e", "KeyE", { metaKey: true }), "other"),
    ).toBeNull();
  });

  it("keeps the key under Shift and Option, and on other layouts", () => {
    // Shift+[ types `{`.
    expect(
      chordFromEvent(
        keyEvent("{", "BracketLeft", { metaKey: true, shiftKey: true }),
        "mac",
      ),
    ).toEqual(chord("Mod+Shift+["));
    // Option+F types `ƒ` on macOS.
    expect(
      chordFromEvent(keyEvent("ƒ", "KeyF", { altKey: true }), "mac"),
    ).toEqual(chord("Alt+f"));
    // Shift+1 types `!`; on AZERTY 1 itself needs Shift.
    expect(
      chordFromEvent(
        keyEvent("!", "Digit1", { ctrlKey: true, shiftKey: true }),
        "other",
      ),
    ).toEqual(chord("Mod+Shift+1"));
    // A Cyrillic layout types `а` on the F key's neighbour.
    expect(
      chordFromEvent(keyEvent("а", "KeyF", { ctrlKey: true }), "other"),
    ).toEqual(chord("Mod+f"));
    // AZERTY types `a` on the physical Q key; the typed letter wins.
    expect(
      chordFromEvent(keyEvent("a", "KeyQ", { ctrlKey: true }), "other"),
    ).toEqual(chord("Mod+a"));
  });

  it("reads Ctrl+` and space by position", () => {
    expect(
      chordFromEvent(keyEvent("`", "Backquote", { ctrlKey: true }), "mac"),
    ).toEqual(chord("Ctrl+`"));
    expect(
      chordFromEvent(keyEvent(" ", "Space", { altKey: true }), "other"),
    ).toEqual(chord("Alt+Space"));
  });
});

describe("formatChord", () => {
  it("uses symbols in macOS order and words elsewhere", () => {
    expect(formatChord(chord("Mod+Shift+f"), "mac")).toBe("⇧⌘F");
    expect(formatChord(chord("Ctrl+`"), "mac")).toBe("⌃`");
    expect(formatChord(chord("Mod+Shift+f"), "other")).toBe("Ctrl+Shift+F");
    expect(formatChord(chord("Alt+ArrowLeft"), "other")).toBe("Alt+←");
  });
});

describe("rules", () => {
  it("lets the terminal keep the shell's control characters only", () => {
    expect(isShellControlChord(chord("Mod+w"), "other")).toBe(true);
    expect(isShellControlChord(chord("Ctrl+w"), "mac")).toBe(true);
    expect(isShellControlChord(chord("Mod+w"), "mac")).toBe(false);
    expect(isShellControlChord(chord("Mod+Shift+f"), "other")).toBe(false);
    expect(isShellControlChord(chord("Ctrl+`"), "other")).toBe(false);
  });

  it("passes only Mod/Ctrl chords the shell does not use out of a terminal", () => {
    expect(isTerminalPassthroughChord(chord("Mod+Shift+f"), "other")).toBe(
      true,
    );
    expect(isTerminalPassthroughChord(chord("Ctrl+`"), "mac")).toBe(true);
    expect(isTerminalPassthroughChord(chord("Mod+,"), "mac")).toBe(true);
    expect(isTerminalPassthroughChord(chord("Mod+b"), "other")).toBe(false);
    expect(isTerminalPassthroughChord(chord("Alt+ArrowLeft"), "other")).toBe(
      false,
    );
    expect(isTerminalPassthroughChord(chord("F2"), "mac")).toBe(false);
  });

  it("leaves Option+arrows to text fields on macOS only", () => {
    expect(isTextEditingChord(chord("Alt+ArrowLeft"), "mac")).toBe(true);
    expect(isTextEditingChord(chord("Alt+ArrowLeft"), "other")).toBe(false);
    expect(isTextEditingChord(chord("Shift+End"), "other")).toBe(true);
    expect(isTextEditingChord(chord("Mod+["), "mac")).toBe(false);
    expect(isTextEditingChord(chord("F2"), "mac")).toBe(false);
  });

  it("needs a modifier unless the key is a function key", () => {
    expect(getChordProblem(chord("k"))).toBe("needsModifier");
    expect(getChordProblem(chord("Shift+k"))).toBe("needsModifier");
    expect(getChordProblem(chord("Alt+k"))).toBeNull();
    expect(getChordProblem(chord("F2"))).toBeNull();
  });
});

describe("defaults", () => {
  for (const platform of ["mac", "other"] as const) {
    it(`parse, are valid, unique and not reserved on ${platform}`, () => {
      const seen = new Map<string, string>();
      for (const action of SHORTCUT_ACTIONS) {
        const text = action.defaults[platform];
        if (text === null) continue;
        const parsed = parseChord(text);
        expect(parsed, `${action.id}: ${text}`).not.toBeNull();
        if (!parsed) continue;
        expect(getChordProblem(parsed)).toBeNull();
        expect(findChordOwner(parsed, {}, platform, action.id)).toBeNull();
        const id = formatChord(parsed, platform);
        expect(seen.get(id), `${action.id} reuses ${id}`).toBeUndefined();
        seen.set(id, action.id);
      }
    });
  }

  it("reserve only chords that parse", () => {
    for (const reserved of RESERVED_SHORTCUTS) {
      for (const text of [...reserved.chords.mac, ...reserved.chords.other]) {
        expect(parseChord(text), text).not.toBeNull();
      }
    }
  });
});

describe("overrides", () => {
  it("store only differences from the default", () => {
    const custom = assignBinding({}, "newChat", chord("Mod+Shift+n"), "other");
    expect(custom).toEqual({ newChat: "Mod+Shift+n" });
    expect(isBindingCustomized("newChat", custom, "other")).toBe(true);

    expect(resetBinding(custom, "newChat", "other")).toEqual({});
    expect(assignBinding({}, "newChat", chord("Mod+n"), "other")).toEqual({});
  });

  it("record an unbound default as null", () => {
    const unbound = assignBinding({}, "newChat", null, "mac");
    expect(unbound).toEqual({ newChat: null });
    expect(getEffectiveBinding("newChat", unbound, "mac")).toBeNull();
  });

  it("take the chord away from the action that had it", () => {
    const next = assignBinding({}, "showBrowser", chord("Mod+b"), "other");
    expect(getEffectiveBinding("showBrowser", next, "other")).toEqual(
      chord("Mod+b"),
    );
    expect(getEffectiveBinding("toggleSidePanel", next, "other")).toBeNull();
    expect(buildChordIndex(next, "other").get("Mod+b")).toBe("showBrowser");

    // Resetting the side panel takes Mod+B back.
    const reset = resetBinding(next, "toggleSidePanel", "other");
    expect(getEffectiveBinding("toggleSidePanel", reset, "other")).toEqual(
      chord("Mod+b"),
    );
    expect(getEffectiveBinding("showBrowser", reset, "other")).toBeNull();
  });

  it("fall back to the default when a stored chord does not parse", () => {
    expect(
      getEffectiveBinding("newChat", { newChat: "Hyper+?" }, "other"),
    ).toEqual(chord("Mod+n"));
  });

  it("treat Ctrl and Mod as one key off macOS", () => {
    expect(findChordOwner(chord("Ctrl+n"), {}, "other")).toEqual({
      id: "newChat",
      kind: "action",
    });
    expect(findChordOwner(chord("Ctrl+n"), {}, "mac")).toBeNull();
    expect(findChordOwner(chord("Mod+r"), {}, "mac")).toEqual({
      id: "reload",
      kind: "reserved",
    });
  });
});
