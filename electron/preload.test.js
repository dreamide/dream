// The preload's `window.dream`, built from the channel table, against what
// the hand-written preload sent before the table existed: every method on
// the same channel, with the same payload.
import assert from "node:assert/strict";
import { afterAll, beforeAll, test, vi } from "vitest";

const exposed = {};
const calls = [];
const listeners = new Map();

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name, api) => {
      exposed[name] = api;
    },
  },
  ipcRenderer: {
    invoke: (...args) => {
      calls.push(["invoke", ...args]);
      return Promise.resolve(true);
    },
    on: (channel, listener) => {
      listeners.set(channel, listener);
    },
    removeListener: (channel, listener) => {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
    send: (...args) => {
      calls.push(["send", ...args]);
    },
    sendSync: (channel) =>
      channel === "api:get-session-token"
        ? "session-token"
        : channel === "host:get-mode"
          ? "service"
          : { accentColor: "rose", baseColor: "neutral", theme: "light" },
  },
}));

const createRoot = () => {
  const classes = new Set();
  const attributes = new Map();
  return {
    attributes,
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    },
    removeAttribute: (name) => attributes.delete(name),
    setAttribute: (name, value) => attributes.set(name, value),
    style: {},
  };
};

const root = createRoot();

beforeAll(async () => {
  globalThis.window = {
    addEventListener: () => {},
    matchMedia: () => ({ matches: true }),
  };
  globalThis.document = { documentElement: root };
  await import("./preload.js");
});

afterAll(() => {
  delete globalThis.window;
  delete globalThis.document;
});

const payload = { any: "payload" };
const png = new Uint8Array([1]);

// method, its arguments, and the IPC call the old preload made for them.
const SENT = [
  [
    "openExternal",
    ["https://x"],
    ["invoke", "shell:open-external", { url: "https://x" }],
  ],
  ["openPath", ["/p"], ["invoke", "shell:open-path", { path: "/p" }]],
  [
    "writeClipboardText",
    ["t"],
    ["invoke", "clipboard:write-text", { text: "t" }],
  ],
  ["writeClipboardImage", [png], ["invoke", "clipboard:write-image", { png }]],
  ["saveTextFile", [payload], ["invoke", "files:save-text", payload]],
  ["captureAppScreenshot", [], ["invoke", "app:capture-screenshot"]],
  [
    "showScreenshotInFolder",
    ["/s.png"],
    ["invoke", "app:show-screenshot-in-folder", { path: "/s.png" }],
  ],
  ["showNotification", [payload], ["invoke", "notifications:show", payload]],
  ["windowMinimize", [], ["invoke", "window:minimize"]],
  ["windowMaximize", [], ["invoke", "window:maximize"]],
  ["windowClose", [], ["invoke", "window:close"]],
  ["pickProjectDirectory", [], ["invoke", "projects:pick-directory"]],
  ["loadState", [], ["invoke", "state:load"]],
  ["pairHost", [payload], ["invoke", "hosts:pair", payload]],
  ["pairHostWithCode", [payload], ["invoke", "hosts:pair-with-code", payload]],
  [
    "cancelHostPairing",
    ["attempt"],
    ["invoke", "hosts:cancel-pairing", { attemptId: "attempt" }],
  ],
  [
    "forgetHostCredential",
    ["credential"],
    ["invoke", "hosts:forget-credential", { credentialId: "credential" }],
  ],
  [
    "saveWorkspaceChanges",
    [payload],
    ["invoke", "state:save-workspace", payload],
  ],
  ["getThemePreferences", [], ["invoke", "theme:get-preferences"]],
  [
    "setThemePreference",
    ["light"],
    ["invoke", "theme:set", { theme: "light" }],
  ],
  [
    "setBaseColor",
    ["slate"],
    ["invoke", "theme:set-base-color", { baseColor: "slate" }],
  ],
  [
    "setAccentColor",
    ["red"],
    ["invoke", "theme:set-accent-color", { accentColor: "red" }],
  ],
  ["connectHost", [payload], ["invoke", "hosts:connect", payload]],
  ["disconnectHost", ["h"], ["invoke", "hosts:disconnect", { hostId: "h" }]],
  ["getHostState", ["h"], ["invoke", "hosts:state", { hostId: "h" }]],
  ["listSshConfigHosts", [], ["invoke", "hosts:ssh-config-hosts"]],
  [
    "forwardHostPort",
    ["h", 3000],
    ["invoke", "hosts:forward-port", { hostId: "h", port: 3000 }],
  ],
  [
    "answerHostPrompt",
    [7, "yes"],
    ["send", "hosts:prompt-answer", { answer: "yes", promptId: 7 }],
  ],
  ["updateBrowser", [payload], ["send", "browser:update", payload]],
  [
    "captureBrowserPage",
    [payload],
    ["invoke", "browser:capture-page", payload],
  ],
  [
    "reportBrowserGuestAttached",
    [payload],
    ["send", "browser:guest-attached", payload],
  ],
  [
    "reportBrowserGuestDetached",
    [payload],
    ["send", "browser:guest-detached", payload],
  ],
  [
    "sendBrowserCommandResult",
    [payload],
    ["send", "browser:command-result", payload],
  ],
  ["detectEditors", [], ["invoke", "editors:detect"]],
  ["openInEditor", [payload], ["invoke", "editors:open", payload]],
  ["getUpdateStatus", [], ["invoke", "updates:get-status"]],
  ["checkForUpdates", [], ["invoke", "updates:check"]],
  ["installUpdate", [], ["invoke", "updates:install"]],
];

const SUBSCRIBED = [
  ["onAppScreenshotRequested", "app:screenshot-requested"],
  ["onNotificationClicked", "notifications:clicked"],
  ["onHostStatus", "hosts:status"],
  ["onHostPrompt", "hosts:prompt"],
  ["onBrowserError", "browser:error"],
  ["onBrowserCommand", "browser:command"],
  ["onBrowserAgentActivity", "browser:agent-activity"],
  ["onUpdateStatus", "updates:status"],
];

test("window.dream has exactly the methods above, and its values", () => {
  const {
    apiSessionToken,
    hostMode,
    initialThemePreferences,
    isElectron,
    ...methods
  } = exposed.dream;
  assert.equal(isElectron, true);
  assert.equal(apiSessionToken, "session-token");
  assert.equal(hostMode, "service");
  assert.deepEqual(initialThemePreferences, {
    accentColor: "rose",
    baseColor: "neutral",
    theme: "light",
  });
  assert.deepEqual(
    Object.keys(methods).sort(),
    [...SENT.map(([m]) => m), ...SUBSCRIBED.map(([m]) => m)].sort(),
  );
});

test("each method sends what the old preload sent", () => {
  for (const [method, args, expected] of SENT) {
    calls.length = 0;
    exposed.dream[method](...args);
    assert.deepEqual(calls, [expected], method);
  }
});

test("each subscription listens on its channel and unsubscribes", () => {
  for (const [method, channel] of SUBSCRIBED) {
    const received = [];
    const unsubscribe = exposed.dream[method]((event) => received.push(event));
    listeners.get(channel)({}, { from: channel });
    assert.deepEqual(received, [{ from: channel }], method);
    unsubscribe();
    assert.equal(listeners.has(channel), false, method);
  }
});

test("the saved theme is on the document before the page runs", () => {
  assert.equal(root.classList.contains("light"), true);
  assert.equal(root.classList.contains("dark"), false);
  assert.equal(root.style.colorScheme, "light");
  assert.equal(root.attributes.has("data-base-color"), false);
  assert.equal(root.attributes.get("data-accent-color"), "rose");
});
