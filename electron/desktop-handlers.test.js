// The desktop handlers with fake Electron parts: what each does with its
// payload, and that, with the modules that register their own, every method
// the renderer calls has exactly one handler.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import {
  createDesktopHandlers,
  desktopDeviceName,
  registerDesktopHandlers,
} from "./desktop-handlers.js";
import { DESKTOP_METHODS } from "./shared/desktop-channels.js";
import { createThemeStore } from "./theme-store.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

const createFakes = ({ window = true } = {}) => {
  const log = [];
  const record =
    (name) =>
    (...args) => {
      log.push([name, ...args]);
    };
  const fakeWindow = {
    close: record("close"),
    focus: record("focus"),
    isMaximized: () => false,
    isMinimized: () => true,
    maximize: record("maximize"),
    minimize: record("minimize"),
    restore: record("restore"),
    setBackgroundColor: record("background"),
    show: record("show"),
    unmaximize: record("unmaximize"),
    webContents: { id: 1 },
  };
  const notifications = [];
  class Notification {
    static isSupported = () => true;
    constructor(options) {
      this.options = options;
      this.listeners = {};
      notifications.push(this);
    }
    on(event, listener) {
      this.listeners[event] = listener;
    }
    show() {
      log.push(["notification", this.options]);
    }
  }
  const saved = [];
  const themes = createThemeStore({
    load: () => ({ accentColor: "green", baseColor: "slate", theme: "dark" }),
    save: (preferences) => saved.push(preferences),
  });
  const existing = new Set();
  const { handlers, paintWindowBackground } = createDesktopHandlers({
    browserSessions: {
      capturePage: (payload) => ({ captured: payload }),
      update: record("browser update"),
    },
    captureAppScreenshot: async ({ chooseSavePath }) => {
      const filePath = await chooseSavePath("shot.png");
      if (filePath) existing.add(filePath);
      return filePath ? { filePath, status: "saved" } : { status: "copied" };
    },
    editors: { detect: () => ["code"], open: (options) => options },
    electron: {
      ClipboardItem: class {
        constructor(items) {
          this.items = items;
        }
      },
      clipboard: {
        write: async (items) => log.push(["clipboard image", items.length]),
        writeText: record("clipboard text"),
      },
      dialog: {
        showOpenDialog: async () => ({ canceled: false, filePaths: ["/work"] }),
        showSaveDialog: async (...args) => {
          const options = args.at(-1);
          return {
            canceled: false,
            filePath: options.defaultPath ?? "/chosen.txt",
          };
        },
      },
      Notification,
      shell: {
        openExternal: record("open external"),
        openPath: async (target) => (target === "/missing" ? "not found" : ""),
        showItemInFolder: record("show in folder"),
      },
    },
    files: {
      exists: (target) => existing.has(target),
      writeFile: async (target, contents) =>
        log.push(["write file", target, contents]),
    },
    getPath: () => "/pictures",
    getWindow: () => (window ? fakeWindow : null),
    hostname: () => "Mikes-MacBook-Pro.local",
    sendToRenderer: record("renderer"),
    sshConfigHosts: async () => ["devbox"],
    sshHosts: {
      connect: async (options) => {
        log.push(["connect", options]);
        return { hostProtocolVersion: 3, token: "secret", version: "1.2" };
      },
      disconnect: record("disconnect"),
      pair: async (options) => {
        log.push(["pair", options.deviceName]);
        return { connectionId: "paired" };
      },
      forwardPort: (_hostId, port) => 40000 + port,
      getState: () => "connected",
    },
    sshPrompts: { answer: record("prompt answer") },
    state: {
      loadWorkspace: () => "workspace",
      saveWorkspaceChanges: (changes) => ({ saved: changes }),
    },
    systemPrefersDark: () => false,
    themes,
  });
  return { handlers, log, notifications, paintWindowBackground, saved, themes };
};

test("links and paths open only when they are what they claim", async () => {
  const { handlers, log } = createFakes();
  assert.equal(handlers.openExternal({ url: "https://dream.dev" }), true);
  assert.equal(handlers.openExternal({ url: "file:///etc/passwd" }), false);
  assert.equal(handlers.openExternal(undefined), false);
  assert.deepEqual(log, [["open external", "https://dream.dev"]]);

  assert.equal(await handlers.openPath({ path: "/work" }), true);
  assert.equal(await handlers.openPath({ path: "/missing" }), false);
  assert.equal(await handlers.openPath({ path: "relative" }), false);
});

test("the clipboard takes text, and only PNG images", async () => {
  const { handlers, log } = createFakes();
  assert.equal(handlers.writeClipboardText({ text: "hi" }), true);
  assert.equal(handlers.writeClipboardText({ text: 4 }), false);
  assert.equal(await handlers.writeClipboardImage({ png: PNG }), true);
  assert.equal(
    await handlers.writeClipboardImage({ png: new Uint8Array([1, 2]) }),
    false,
  );
  assert.deepEqual(log, [
    ["clipboard text", "hi"],
    ["clipboard image", 1],
  ]);
});

test("a saved screenshot can be shown in its folder; nothing else can", async () => {
  const { handlers, log } = createFakes();
  const result = await handlers.captureAppScreenshot();
  assert.deepEqual(result, {
    filePath: path.join("/pictures", "shot.png"),
    status: "saved",
  });
  assert.equal(
    handlers.showScreenshotInFolder({ path: result.filePath }),
    true,
  );
  assert.equal(handlers.showScreenshotInFolder({ path: "/etc/hosts" }), false);
  assert.deepEqual(log, [["show in folder", result.filePath]]);
});

test("a text file is written where the dialog says", async () => {
  const { handlers, log } = createFakes();
  assert.equal(
    await handlers.saveTextFile({ contents: "x", defaultPath: " /a.txt " }),
    true,
  );
  assert.equal(await handlers.saveTextFile({ contents: 5 }), false);
  assert.deepEqual(log, [["write file", "/a.txt", "x"]]);
});

test("clicking a notification brings the window back and opens its chat", () => {
  const { handlers, log, notifications } = createFakes();
  assert.equal(handlers.showNotification({ title: " " }), false);
  assert.equal(
    handlers.showNotification({ body: "b", chatId: "c1", title: "Done" }),
    true,
  );
  notifications[0].listeners.click();
  assert.deepEqual(log, [
    ["notification", { body: "b", silent: false, title: "Done" }],
    ["restore"],
    ["show"],
    ["focus"],
    ["renderer", "notifications:clicked", { chatId: "c1" }],
  ]);
});

test("window controls act on the window, and nothing without one", () => {
  const { handlers, log } = createFakes();
  handlers.windowMinimize();
  handlers.windowMaximize();
  handlers.windowClose();
  assert.deepEqual(log, [["minimize"], ["maximize"], ["close"]]);

  const closed = createFakes({ window: false });
  closed.handlers.windowMinimize();
  closed.handlers.windowClose();
  assert.deepEqual(closed.log, []);
});

test("a theme change is saved and repaints the window", () => {
  const { handlers, log, saved } = createFakes();
  assert.deepEqual(handlers.getThemePreferences(), {
    accentColor: "green",
    baseColor: "slate",
    theme: "dark",
  });
  handlers.setThemePreference({ theme: "light" });
  handlers.setBaseColor({ baseColor: "nope" });
  handlers.setAccentColor({ accentColor: "rose" });
  assert.deepEqual(saved.at(-1), {
    accentColor: "rose",
    baseColor: "slate",
    theme: "light",
  });
  assert.deepEqual(log, [
    ["background", "#ffffff"],
    ["background", "#ffffff"],
  ]);
});

test("SSH host calls are checked before they reach the hosts", async () => {
  const { handlers, log } = createFakes();
  await assert.rejects(() => handlers.connectHost({ hostId: "h" }));
  assert.deepEqual(
    await handlers.connectHost({
      hostCommand: " ",
      hostId: "h",
      target: " box ",
    }),
    { fingerprint: null, hostId: null, hostProtocolVersion: 3, version: "1.2" },
  );
  assert.throws(() => handlers.forwardHostPort({ hostId: "h", port: 70000 }));
  assert.equal(handlers.forwardHostPort({ hostId: "h", port: "3000" }), 43000);
  assert.equal(handlers.getHostState({}), "idle");
  assert.deepEqual(await handlers.listSshConfigHosts(), ["devbox"]);
  handlers.answerHostPrompt({ answer: "pw", promptId: 2 });
  assert.deepEqual(log, [
    [
      "connect",
      {
        expectedIdentity: null,
        hostCommand: undefined,
        hostId: "h",
        target: "box",
      },
    ],
    ["prompt answer", 2, "pw"],
  ]);
});

// Registered by the modules that own them, on the same table's channels.
const REGISTERED_ELSEWHERE = [
  "checkForUpdates",
  "getUpdateStatus",
  "installUpdate",
  "reportBrowserGuestAttached",
  "reportBrowserGuestDetached",
  "sendBrowserCommandResult",
];

test("a pairing names this desktop by its computer, then the client", async () => {
  const { handlers, log } = createFakes();
  const url = "https://host.example/pair#pair=secret";
  await handlers.pairHost({ url });
  await handlers.pairHost({ url, deviceName: "Studio" });
  assert.deepEqual(log, [
    ["pair", "Mikes-MacBook-Pro · Dream desktop"],
    ["pair", "Studio"],
  ]);
  assert.equal(desktopDeviceName(""), "Computer · Dream desktop");
});

test("every method the renderer calls is handled once, on its channel", () => {
  const { handlers } = createFakes();
  const handled = [];
  const ipcMain = {
    handle: (channel) => handled.push(["invoke", channel]),
    on: (channel) => handled.push(["send", channel]),
  };
  registerDesktopHandlers(ipcMain, handlers);

  const called = Object.entries(DESKTOP_METHODS).filter(
    ([, spec]) => spec.kind !== "subscribe",
  );
  assert.deepEqual(
    [...Object.keys(handlers), ...REGISTERED_ELSEWHERE].sort(),
    called.map(([method]) => method).sort(),
  );
  assert.deepEqual(
    handled.sort(),
    called
      .filter(([method]) => !REGISTERED_ELSEWHERE.includes(method))
      .map(([, spec]) => [spec.kind, spec.channel])
      .sort(),
  );
  assert.throws(() =>
    registerDesktopHandlers(ipcMain, { onHostStatus: () => {} }),
  );
});

test("every channel is used by one method", () => {
  const channels = Object.values(DESKTOP_METHODS).map((spec) => spec.channel);
  assert.equal(new Set(channels).size, channels.length);
});
