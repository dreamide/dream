import { ipcMain, webContents } from "electron";

/**
 * Main-process bridge that lets agent tools drive the renderer's `<webview>`
 * browser tabs.
 *
 * The renderer owns tab state (zustand) and the `<webview>` elements. It
 * reports each mounted guest's `webContentsId` here so tools can reach the
 * guest directly via `webContents.fromId`, and it answers commands (open a
 * tab, activate a tab, ...) that only the renderer can perform.
 *
 * Per guest, the bridge also keeps a console buffer (from `console-message`)
 * and a network buffer (from the Chrome DevTools Protocol via
 * `webContents.debugger`), both reset on each main-frame navigation.
 */

const COMMAND_TIMEOUT_MS = 8_000;
const GUEST_WAIT_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 20_000;
const CONSOLE_BUFFER_LIMIT = 300;
const NETWORK_BUFFER_LIMIT = 400;
const CDP_PROTOCOL_VERSION = "1.3";

const CONSOLE_LEVELS = ["debug", "info", "warning", "error"];

const createId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const pushBounded = (list, entry, limit) => {
  list.push(entry);
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
};

export function createBrowserAgentBridge({ sendToRenderer }) {
  /** @type {Map<string, Map<string, {webContentsId:number, attachedAt:number}>>} */
  const guestsByProject = new Map();
  /**
   * @type {Map<number, {
   *   console: Array<object>,
   *   network: Array<object>,
   *   networkById: Map<string, object>,
   *   debuggerState: "detached"|"attaching"|"attached"|"failed",
   *   debuggerError: string|null,
   *   cleanup: () => void,
   * }>}
   */
  const guestMeta = new Map();
  /** @type {Map<string, {resolve: Function, reject: Function, timer: any}>} */
  const pendingCommands = new Map();
  /** @type {Set<() => void>} */
  const guestWaiters = new Set();
  /** @type {Map<string, Map<string, number>>} projectId -> tool -> running count */
  const activityByProject = new Map();

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

  // -------------------------------------------------------------------------
  // CDP (network capture, file inputs)
  // -------------------------------------------------------------------------

  const recordNetworkEvent = (meta, method, params) => {
    if (method === "Network.requestWillBeSent") {
      const entry = {
        id: params.requestId,
        initiator: params.initiator?.type,
        method: params.request?.method,
        resourceType: params.type,
        startedAt: Date.now(),
        status: null,
        url: params.request?.url,
      };
      // Redirects reuse the requestId; keep the chain visible.
      const previous = meta.networkById.get(params.requestId);
      if (previous && params.redirectResponse) {
        previous.status = params.redirectResponse.status;
        previous.redirectedTo = params.request?.url;
        previous.finished = true;
      }
      meta.networkById.set(params.requestId, entry);
      pushBounded(meta.network, entry, NETWORK_BUFFER_LIMIT);
      return;
    }
    const entry = params?.requestId
      ? meta.networkById.get(params.requestId)
      : null;
    if (!entry) {
      return;
    }
    if (method === "Network.responseReceived") {
      entry.status = params.response?.status ?? null;
      entry.mimeType = params.response?.mimeType;
      entry.fromCache =
        Boolean(params.response?.fromDiskCache) ||
        Boolean(params.response?.fromServiceWorker);
    } else if (method === "Network.loadingFinished") {
      entry.finished = true;
      entry.durationMs = Date.now() - entry.startedAt;
      entry.encodedBytes = params.encodedDataLength;
    } else if (method === "Network.loadingFailed") {
      entry.finished = true;
      entry.failed = true;
      entry.error = params.errorText;
      entry.canceled = Boolean(params.canceled);
      entry.durationMs = Date.now() - entry.startedAt;
    }
  };

  const attachDebugger = async (guest) => {
    const meta = guestMeta.get(guest.id);
    if (!meta || guest.isDestroyed()) {
      return false;
    }
    if (meta.debuggerState === "attached") {
      return true;
    }
    if (meta.debuggerState === "attaching") {
      return false;
    }
    meta.debuggerState = "attaching";
    try {
      if (!guest.debugger.isAttached()) {
        guest.debugger.attach(CDP_PROTOCOL_VERSION);
      }
      await guest.debugger.sendCommand("Network.enable", {
        maxPostDataSize: 0,
      });
      meta.debuggerState = "attached";
      meta.debuggerError = null;
      return true;
    } catch (error) {
      meta.debuggerState = "failed";
      meta.debuggerError =
        error instanceof Error ? error.message : String(error);
      return false;
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
      const meta = guestMeta.get(webContentsId);
      if (!meta) {
        return;
      }
      pushBounded(
        meta.console,
        {
          level: String(details.level ?? "info"),
          lineNumber: details.lineNumber,
          message: String(details.message ?? ""),
          sourceId: details.sourceId,
          timestamp: Date.now(),
        },
        CONSOLE_BUFFER_LIMIT,
      );
    };
    const handleNavigationStart = (_event, _url, isInPlace, isMainFrame) => {
      const meta = guestMeta.get(webContentsId);
      if (meta && isMainFrame && !isInPlace) {
        meta.console.length = 0;
        meta.network.length = 0;
        meta.networkById.clear();
      }
    };
    const handleDestroyed = () => {
      cleanupGuest(webContentsId);
    };
    const handleDebuggerMessage = (_event, method, params) => {
      const meta = guestMeta.get(webContentsId);
      if (meta && method.startsWith("Network.")) {
        recordNetworkEvent(meta, method, params ?? {});
      }
    };
    const handleDebuggerDetach = () => {
      const meta = guestMeta.get(webContentsId);
      if (meta) {
        // Re-attached lazily on the next network read.
        meta.debuggerState = "detached";
      }
    };

    guest.on("console-message", handleConsole);
    guest.on("did-start-navigation", handleNavigationStart);
    guest.once("destroyed", handleDestroyed);
    guest.debugger.on("message", handleDebuggerMessage);
    guest.debugger.on("detach", handleDebuggerDetach);

    guestMeta.set(webContentsId, {
      cleanup: () => {
        if (!guest.isDestroyed()) {
          guest.removeListener("console-message", handleConsole);
          guest.removeListener("did-start-navigation", handleNavigationStart);
          guest.removeListener("destroyed", handleDestroyed);
          guest.debugger.removeListener("message", handleDebuggerMessage);
          guest.debugger.removeListener("detach", handleDebuggerDetach);
          try {
            if (guest.debugger.isAttached()) {
              guest.debugger.detach();
            }
          } catch {
            // Already gone.
          }
        }
      },
      console: [],
      debuggerError: null,
      debuggerState: "detached",
      network: [],
      networkById: new Map(),
    });

    // Attach eagerly so requests made during the first load are captured.
    void attachDebugger(guest);
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
  // Main -> renderer: activity indicator
  // -------------------------------------------------------------------------

  /**
   * Track a running tool so the panel can show that an agent is driving the
   * browser. Returns a function that marks the tool finished.
   */
  function beginActivity(projectId, tool) {
    if (!projectId) {
      return () => {};
    }
    let counts = activityByProject.get(projectId);
    if (!counts) {
      counts = new Map();
      activityByProject.set(projectId, counts);
    }
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
    publishActivity(projectId, tool);
    let ended = false;
    return () => {
      if (ended) {
        return;
      }
      ended = true;
      const current = activityByProject.get(projectId);
      if (!current) {
        return;
      }
      const next = (current.get(tool) ?? 1) - 1;
      if (next <= 0) {
        current.delete(tool);
      } else {
        current.set(tool, next);
      }
      if (current.size === 0) {
        activityByProject.delete(projectId);
      }
      publishActivity(projectId, tool);
    };
  }

  function publishActivity(projectId, tool) {
    const counts = activityByProject.get(projectId);
    sendToRenderer("browser:agent-activity", {
      active: Boolean(counts && counts.size > 0),
      projectId,
      tool,
      tools: counts ? [...counts.keys()] : [],
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

  // -------------------------------------------------------------------------
  // Buffers and CDP-backed operations
  // -------------------------------------------------------------------------

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

  /**
   * Network requests captured since the last navigation. `capturing` is false
   * when the DevTools Protocol could not be attached (e.g. another debugger
   * holds the guest); `reason` says why.
   */
  async function getNetworkEntries(guest, { clear = false } = {}) {
    const meta = guestMeta.get(guest.id);
    if (!meta) {
      return { capturing: false, entries: [], reason: "Tab is not tracked." };
    }
    const attached = await attachDebugger(guest);
    const entries = meta.network.map((entry) => ({ ...entry }));
    if (clear) {
      meta.network.length = 0;
      meta.networkById.clear();
    }
    return {
      capturing: attached,
      entries,
      reason: attached ? null : meta.debuggerError,
    };
  }

  async function getResponseBody(guest, requestId) {
    if (!(await attachDebugger(guest))) {
      const meta = guestMeta.get(guest.id);
      throw new Error(
        `Network capture is unavailable for this tab${meta?.debuggerError ? `: ${meta.debuggerError}` : "."}`,
      );
    }
    const meta = guestMeta.get(guest.id);
    const entry = meta?.networkById.get(requestId) ?? null;
    const result = await guest.debugger.sendCommand("Network.getResponseBody", {
      requestId,
    });
    return {
      base64Encoded: Boolean(result.base64Encoded),
      body: result.body,
      entry,
    };
  }

  /**
   * Set the files of an `<input type="file">` via CDP. `expression` must
   * evaluate to the input element in the page (e.g. a snapshot ref lookup).
   */
  async function setFileInputFiles(guest, expression, files) {
    if (!(await attachDebugger(guest))) {
      const meta = guestMeta.get(guest.id);
      throw new Error(
        `File uploads need the DevTools Protocol, which is unavailable for this tab${meta?.debuggerError ? `: ${meta.debuggerError}` : "."}`,
      );
    }
    const evaluated = await guest.debugger.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: false,
    });
    if (evaluated.exceptionDetails) {
      throw new Error(
        evaluated.exceptionDetails.exception?.description ??
          "Could not locate the file input.",
      );
    }
    const objectId = evaluated.result?.objectId;
    if (!objectId) {
      throw new Error("Could not locate the file input element.");
    }
    try {
      await guest.debugger.sendCommand("DOM.enable");
      await guest.debugger.sendCommand("DOM.setFileInputFiles", {
        files,
        objectId,
      });
    } finally {
      void guest.debugger
        .sendCommand("Runtime.releaseObject", { objectId })
        .catch(() => {});
    }
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
    activityByProject.clear();
  }

  return {
    beginActivity,
    getConsoleEntries,
    getGuest,
    getNetworkEntries,
    getResponseBody,
    reset,
    sendCommand,
    setFileInputFiles,
    waitForGuest,
    waitForLoad,
  };
}
