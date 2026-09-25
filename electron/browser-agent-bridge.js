import { ipcMain, webContents } from "electron";

/**
 * Main-process bridge that lets agent tools drive the renderer's `<webview>`
 * browser tabs.
 *
 * The renderer owns tab state (zustand) and the `<webview>` elements. It
 * reports each mounted guest's `webContentsId` here so tools can reach the
 * guest directly via `webContents.fromId`, and it answers commands (open a
 * tab, activate a tab, ...) that only the renderer can perform.
 */

const COMMAND_TIMEOUT_MS = 8_000;
const GUEST_WAIT_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 20_000;
const CONSOLE_BUFFER_LIMIT = 300;

const CONSOLE_LEVELS = ["debug", "info", "warning", "error"];

const createId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function createBrowserAgentBridge({ sendToRenderer }) {
  /** @type {Map<string, Map<string, {webContentsId:number, attachedAt:number}>>} */
  const guestsByProject = new Map();
  /** @type {Map<number, {console: Array<object>, cleanup: () => void}>} */
  const guestMeta = new Map();
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const pendingCommands = new Map();
  /** @type {Set<() => void>} */
  const guestWaiters = new Set();

  const getProjectGuests = (projectId) => {
    let map = guestsByProject.get(projectId);
    if (!map) {
      map = new Map();
      guestsByProject.set(projectId, map);
    }
    return map;
  };

  const notifyGuestWaiters = () => {
    for (const waiter of [...guestWaiters]) {
      waiter();
    }
  };

  const liveGuest = (webContentsId) => {
    const guest = webContents.fromId(webContentsId);
    return guest && !guest.isDestroyed() ? guest : null;
  };

  const pushConsoleEntry = (webContentsId, entry) => {
    const meta = guestMeta.get(webContentsId);
    if (!meta) {
      return;
    }
    meta.console.push(entry);
    if (meta.console.length > CONSOLE_BUFFER_LIMIT) {
      meta.console.splice(0, meta.console.length - CONSOLE_BUFFER_LIMIT);
    }
  };

  const hookGuest = (webContentsId) => {
    if (guestMeta.has(webContentsId)) {
      return;
    }
    const guest = liveGuest(webContentsId);
    if (!guest) {
      return;
    }

    // Electron >= 32 passes a details object; older versions pass positional
    // arguments. Support both so the buffer never silently stays empty.
    const handleConsole = (eventOrDetails, level, message, line, sourceId) => {
      const details =
        eventOrDetails && typeof eventOrDetails.message === "string"
          ? eventOrDetails
          : {
              level: CONSOLE_LEVELS[Number(level)] ?? String(level),
              lineNumber: line,
              message,
              sourceId,
            };
      pushConsoleEntry(webContentsId, {
        level: String(details.level ?? "info"),
        lineNumber: details.lineNumber,
        message: String(details.message ?? ""),
        sourceId: details.sourceId,
        timestamp: Date.now(),
      });
    };
    const handleNavigationStart = (_event, _url, isInPlace, isMainFrame) => {
      const meta = guestMeta.get(webContentsId);
      if (meta && isMainFrame && !isInPlace) {
        meta.console.length = 0;
      }
    };
    const handleDestroyed = () => {
      cleanupGuest(webContentsId);
    };

    guest.on("console-message", handleConsole);
    guest.on("did-start-navigation", handleNavigationStart);
    guest.once("destroyed", handleDestroyed);

    guestMeta.set(webContentsId, {
      console: [],
      cleanup: () => {
        if (!guest.isDestroyed()) {
          guest.removeListener("console-message", handleConsole);
          guest.removeListener("did-start-navigation", handleNavigationStart);
          guest.removeListener("destroyed", handleDestroyed);
        }
      },
    });
  };

  function cleanupGuest(webContentsId) {
    const meta = guestMeta.get(webContentsId);
    if (meta) {
      meta.cleanup();
      guestMeta.delete(webContentsId);
    }
    for (const [projectId, guests] of guestsByProject) {
      for (const [tabId, entry] of guests) {
        if (entry.webContentsId === webContentsId) {
          guests.delete(tabId);
        }
      }
      if (guests.size === 0) {
        guestsByProject.delete(projectId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Renderer -> main: guest registry
  // -------------------------------------------------------------------------

  ipcMain.on("browser:guest-attached", (_event, payload) => {
    const projectId =
      typeof payload?.projectId === "string" ? payload.projectId : "";
    const tabId = typeof payload?.tabId === "string" ? payload.tabId : "";
    const webContentsId = Number(payload?.webContentsId);
    if (!projectId || !tabId || !Number.isInteger(webContentsId)) {
      return;
    }
    if (!liveGuest(webContentsId)) {
      return;
    }

    const guests = getProjectGuests(projectId);
    const existing = guests.get(tabId);
    if (existing && existing.webContentsId !== webContentsId) {
      cleanupGuest(existing.webContentsId);
    }
    guests.set(tabId, { attachedAt: Date.now(), webContentsId });
    hookGuest(webContentsId);
    notifyGuestWaiters();
  });

  ipcMain.on("browser:guest-detached", (_event, payload) => {
    const projectId =
      typeof payload?.projectId === "string" ? payload.projectId : "";
    const tabId = typeof payload?.tabId === "string" ? payload.tabId : "";
    const guests = guestsByProject.get(projectId);
    const entry = guests?.get(tabId);
    if (!entry) {
      return;
    }
    guests.delete(tabId);
    if (guests.size === 0) {
      guestsByProject.delete(projectId);
    }
    const stillReferenced = [...guestsByProject.values()].some((map) =>
      [...map.values()].some(
        (item) => item.webContentsId === entry.webContentsId,
      ),
    );
    if (!stillReferenced) {
      const meta = guestMeta.get(entry.webContentsId);
      if (meta) {
        meta.cleanup();
        guestMeta.delete(entry.webContentsId);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Main -> renderer: commands
  // -------------------------------------------------------------------------

  ipcMain.on("browser:command-result", (_event, payload) => {
    const id = typeof payload?.id === "string" ? payload.id : "";
    const pending = pendingCommands.get(id);
    if (!pending) {
      return;
    }
    pendingCommands.delete(id);
    clearTimeout(pending.timer);
    if (payload.ok) {
      pending.resolve(payload.result ?? null);
    } else {
      pending.reject(
        new Error(
          typeof payload.error === "string" && payload.error
            ? payload.error
            : "Browser command failed in the renderer.",
        ),
      );
    }
  });

  function sendCommand(projectId, type, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = createId();
      const timer = setTimeout(() => {
        pendingCommands.delete(id);
        reject(
          new Error(
            `The app window did not respond to browser command "${type}". Is the Dream window open?`,
          ),
        );
      }, COMMAND_TIMEOUT_MS);
      pendingCommands.set(id, { reject, resolve, timer });
      sendToRenderer("browser:command", { id, payload, projectId, type });
    });
  }

  // -------------------------------------------------------------------------
  // Guest lookup / waiting
  // -------------------------------------------------------------------------

  function getGuest(projectId, tabId) {
    const entry = guestsByProject.get(projectId)?.get(tabId);
    if (!entry) {
      return null;
    }
    const guest = liveGuest(entry.webContentsId);
    if (!guest) {
      cleanupGuest(entry.webContentsId);
      return null;
    }
    return guest;
  }

  function waitForGuest(projectId, tabId, timeoutMs = GUEST_WAIT_TIMEOUT_MS) {
    const immediate = getGuest(projectId, tabId);
    if (immediate) {
      return Promise.resolve(immediate);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        guestWaiters.delete(check);
        reject(
          new Error(
            "Timed out waiting for the browser tab to mount. The browser panel may be hidden or the tab has no URL yet.",
          ),
        );
      }, timeoutMs);
      const check = () => {
        const guest = getGuest(projectId, tabId);
        if (guest) {
          clearTimeout(timer);
          guestWaiters.delete(check);
          resolve(guest);
        }
      };
      guestWaiters.add(check);
    });
  }

  /**
   * Resolve once the guest has finished (or failed) its current load.
   * Resolves immediately when nothing is loading.
   */
  function waitForLoad(guest, { timeoutMs = LOAD_TIMEOUT_MS } = {}) {
    if (guest.isDestroyed()) {
      return Promise.reject(new Error("Browser tab was closed."));
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (failure) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        guest.removeListener("did-stop-loading", onStop);
        guest.removeListener("did-fail-load", onFail);
        guest.removeListener("destroyed", onDestroyed);
        resolve(failure ?? null);
      };
      const onStop = () => finish(null);
      const onFail = (
        _event,
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame,
      ) => {
        if (isMainFrame === false || errorCode === -3) {
          return;
        }
        finish({ errorCode, errorDescription, url: validatedURL });
      };
      const onDestroyed = () =>
        finish({ errorDescription: "Browser tab was closed." });
      const timer = setTimeout(
        () =>
          finish({
            errorDescription: `Page did not finish loading within ${timeoutMs}ms.`,
            timeout: true,
          }),
        timeoutMs,
      );

      guest.on("did-stop-loading", onStop);
      guest.on("did-fail-load", onFail);
      guest.once("destroyed", onDestroyed);

      // Give a freshly issued loadURL a tick to flip isLoading before we
      // check; otherwise resolve right away for an idle page.
      setTimeout(() => {
        if (!settled && !guest.isDestroyed() && !guest.isLoading()) {
          finish(null);
        }
      }, 50);
    });
  }

  function getConsoleEntries(guest, { clear = false } = {}) {
    const meta = guestMeta.get(guest.id);
    if (!meta) {
      return [];
    }
    const entries = [...meta.console];
    if (clear) {
      meta.console.length = 0;
    }
    return entries;
  }

  function reset() {
    for (const pending of pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The app window was closed."));
    }
    pendingCommands.clear();
    for (const webContentsId of [...guestMeta.keys()]) {
      cleanupGuest(webContentsId);
    }
    guestsByProject.clear();
  }

  return {
    getConsoleEntries,
    getGuest,
    reset,
    sendCommand,
    waitForGuest,
    waitForLoad,
  };
}
