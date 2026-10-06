import type { KeyPlatform } from "./chord";

/**
 * Every customizable shortcut, with its default on each platform.
 *
 * Defaults follow the convention users already know from VS Code, Chrome and
 * the platform itself, so nothing here has to be learned:
 *
 *   Mod+,             Settings (macOS standard; VS Code, Cursor, Zed)
 *   Mod+N / Mod+O     New / Open (every desktop app)
 *   Mod+Shift+F       Search everywhere (VS Code)
 *   ⌘[ ⌘] / Alt+← →   Back / Forward (Safari/Finder; Chrome, Edge, Explorer)
 *   Ctrl+Tab          Next tab (Chrome, VS Code, Safari)
 *   Mod+L             Focus the chat input (Cursor, and the browser address bar)
 *   Ctrl+H / ⌘Y       History (Chrome)
 *   Mod+\             Split side by side (VS Code split editor)
 *   Mod+B             Toggle side bar (VS Code)
 *   Ctrl+`            Toggle terminal (VS Code, every platform)
 *   Mod+Shift+E       Explorer (VS Code)
 *   Ctrl+Shift+G      Source control (VS Code, every platform)
 *   Mod+S             Save
 *
 * The browser, pull request and stash panels have no shared convention, so
 * they start unbound and can be given a key in Settings.
 *
 * An action's id is also its persisted key in `settings.keybindings`, so it
 * must never be renamed.
 */
export const SHORTCUT_CATEGORIES = [
  "general",
  "navigation",
  "chat",
  "panels",
  "editor",
] as const;

export type ShortcutCategory = (typeof SHORTCUT_CATEGORIES)[number];

interface ShortcutActionDefinition {
  category: ShortcutCategory;
  defaults: Record<KeyPlatform, string | null>;
  id: string;
}

const same = (chord: string | null) => ({ mac: chord, other: chord });

export const SHORTCUT_ACTIONS = [
  { category: "general", defaults: same("Mod+,"), id: "openSettings" },
  { category: "general", defaults: same("Mod+Shift+F"), id: "searchChats" },
  { category: "general", defaults: same("Mod+O"), id: "openProject" },
  {
    category: "navigation",
    defaults: { mac: "Mod+[", other: "Alt+ArrowLeft" },
    id: "navigateBack",
  },
  {
    category: "navigation",
    defaults: { mac: "Mod+]", other: "Alt+ArrowRight" },
    id: "navigateForward",
  },
  {
    category: "navigation",
    defaults: same("Ctrl+Tab"),
    id: "nextProject",
  },
  {
    category: "navigation",
    defaults: same("Ctrl+Shift+Tab"),
    id: "previousProject",
  },
  { category: "chat", defaults: same("Mod+N"), id: "newChat" },
  { category: "chat", defaults: same("Mod+L"), id: "focusChatInput" },
  {
    category: "chat",
    // Cmd+H hides the app on macOS, so Chrome's history key is Cmd+Y there.
    defaults: { mac: "Mod+Y", other: "Mod+H" },
    id: "toggleChatHistory",
  },
  { category: "chat", defaults: same("Mod+\\"), id: "toggleSideBySide" },
  { category: "panels", defaults: same("Mod+B"), id: "toggleSidePanel" },
  { category: "panels", defaults: same("Ctrl+`"), id: "toggleTerminal" },
  { category: "panels", defaults: same("Mod+Shift+E"), id: "showFiles" },
  { category: "panels", defaults: same("Ctrl+Shift+G"), id: "showChanges" },
  { category: "panels", defaults: same(null), id: "showBrowser" },
  { category: "panels", defaults: same(null), id: "showPullRequests" },
  { category: "panels", defaults: same(null), id: "showStash" },
  { category: "editor", defaults: same("Mod+S"), id: "saveFile" },
] as const satisfies readonly ShortcutActionDefinition[];

export type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number]["id"];

export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

const ACTION_BY_ID = new Map<string, ShortcutAction>(
  SHORTCUT_ACTIONS.map((action) => [action.id, action]),
);

export const getShortcutAction = (id: string): ShortcutAction | undefined =>
  ACTION_BY_ID.get(id);

export const isShortcutActionId = (id: string): id is ShortcutActionId =>
  ACTION_BY_ID.has(id);

/**
 * Keys the app or the OS handles before a shortcut could see them. They are
 * listed so a recorded shortcut that collides with one is refused instead of
 * silently never firing. `shown` ones are also listed read-only in Settings.
 */
interface ReservedShortcutDefinition {
  chords: Record<KeyPlatform, readonly string[]>;
  id: string;
  shown: boolean;
}

export const RESERVED_SHORTCUTS = [
  // Typing in the chat composer.
  {
    chords: { mac: ["Enter"], other: ["Enter"] },
    id: "sendMessage",
    shown: true,
  },
  {
    chords: { mac: ["Shift+Enter"], other: ["Shift+Enter"] },
    id: "newLine",
    shown: true,
  },
  {
    chords: { mac: ["ArrowUp"], other: ["ArrowUp"] },
    id: "previousPrompt",
    shown: true,
  },
  // The main process intercepts these before the page sees them, with
  // either Ctrl or Cmd (electron/main.js, electron/app-screenshot.js).
  {
    chords: { mac: ["Mod+R", "Ctrl+R"], other: ["Mod+R", "F5"] },
    id: "reload",
    shown: true,
  },
  {
    chords: {
      mac: ["Mod+Shift+R", "Ctrl+Shift+R"],
      other: ["Mod+Shift+R", "Mod+F5"],
    },
    id: "forceReload",
    shown: true,
  },
  {
    chords: { mac: ["Mod+Alt+I", "Ctrl+Shift+I"], other: ["Mod+Shift+I"] },
    id: "toggleDevTools",
    shown: true,
  },
  {
    chords: {
      mac: ["Mod+Shift+S", "Ctrl+Shift+S"],
      other: ["Mod+Shift+S"],
    },
    id: "captureScreenshot",
    shown: true,
  },
  // Text editing, everywhere.
  {
    chords: {
      mac: ["Mod+A", "Mod+C", "Mod+V", "Mod+X", "Mod+Z", "Mod+Shift+Z"],
      other: ["Mod+A", "Mod+C", "Mod+V", "Mod+X", "Mod+Z", "Mod+Y"],
    },
    id: "textEditing",
    shown: false,
  },
  // The macOS application menu (electron/app-menu.js) and the system.
  {
    chords: {
      mac: [
        "Mod+Q",
        "Mod+H",
        "Mod+Alt+H",
        "Mod+M",
        "Mod+0",
        "Mod+=",
        "Mod+-",
        "Mod+Ctrl+F",
        "Mod+Tab",
        "Mod+Space",
      ],
      other: ["Alt+F4"],
    },
    id: "system",
    shown: false,
  },
] as const satisfies readonly ReservedShortcutDefinition[];

export type ReservedShortcutId = (typeof RESERVED_SHORTCUTS)[number]["id"];
