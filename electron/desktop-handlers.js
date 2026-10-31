// @ts-check
// What the main process does for each desktop method the renderer calls
// (shared/desktop-channels.js), as plain functions of the call's payload.
// Everything Electron and the app provide is passed in, so the handlers are
// tested with fakes (desktop-handlers.test.js) and main.js only wires them:
// `registerDesktopHandlers` puts each one on its channel.
//
// Not here: the update methods (updater.js) and the browser agent's
// guest and command-result messages (browser-agent-bridge.js), which
// register themselves on the same table's channels.
import path from "node:path";
import { DESKTOP_METHODS } from "./shared/desktop-channels.js";
import { MAX_HOST_ROUTES } from "./shared/host-connections.js";

/** @typedef {import("./shared/desktop-channels.js").DesktopMethod} DesktopMethod */

/**
 * @typedef {object} DesktopWindow
 * @property {() => boolean} isMinimized
 * @property {() => boolean} isMaximized
 * @property {() => void} minimize
 * @property {() => void} maximize
 * @property {() => void} unmaximize
 * @property {() => void} restore
 * @property {() => void} show
 * @property {() => void} focus
 * @property {() => void} close
 * @property {(color: string) => void} setBackgroundColor
 * @property {unknown} webContents
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** @param {unknown} bytes */
export const isPngBytes = (bytes) =>
  bytes instanceof Uint8Array &&
  bytes.length > PNG_SIGNATURE.length &&
  PNG_SIGNATURE.every((value, index) => bytes[index] === value);

/** @param {string} value */
export const isHttpUrl = (value) => /^https?:\/\//i.test(value.trim());

/**
 * How this desktop names itself to a host it pairs with: the computer, then
 * the client, as a browser does ("iPhone · Safari"). The host lists paired
 * devices by this name.
 * @param {string} hostname The OS host name, e.g. `Mikes-MacBook-Pro.local`.
 */
export const desktopDeviceName = (hostname) =>
  `${hostname.trim().split(".")[0] || "Computer"} · Dream desktop`;

/**
 * @param {any} payload
 * @returns {Record<string, any>}
 */
const fields = (payload) =>
  payload && typeof payload === "object" ? payload : {};

/**
 * What a pairing request may say about the host it expects and this
 * device: the saved identities to recognise, and the device's name.
 */
const pairingIdentity = (payload, fallbackName) => {
  const { deviceName, expectedHostId, expectedFingerprint, knownIdentities } =
    fields(payload);
  return {
    knownIdentities: Array.isArray(knownIdentities)
      ? knownIdentities
          .filter(
            (host) =>
              typeof host?.hostId === "string" &&
              (host.fingerprint === null ||
                typeof host.fingerprint === "string"),
          )
          .slice(0, 1000)
      : [],
    deviceName: (
      (typeof deviceName === "string" && deviceName) ||
      fallbackName
    ).slice(0, 200),
    expectedIdentity:
      typeof expectedHostId === "string" && expectedHostId
        ? { hostId: expectedHostId, fingerprint: expectedFingerprint }
        : null,
  };
};

/**
 * @param {object} deps
 * @param {() => DesktopWindow | null} deps.getWindow The main window, while
 *   it is alive.
 * @param {(channel: string, payload?: unknown) => void} deps.sendToRenderer
 * @param {object} deps.electron Electron's parts the handlers use.
 * @param {{ writeText: (text: string) => void, write: (items: unknown[]) => Promise<void> }} deps.electron.clipboard
 * @param {new (items: Record<string, Blob>) => unknown} deps.electron.ClipboardItem
 * @param {{ showSaveDialog: (...args: any[]) => Promise<{ canceled: boolean, filePath?: string }>, showOpenDialog: (...args: any[]) => Promise<{ canceled: boolean, filePaths: string[] }> }} deps.electron.dialog
 * @param {{ isSupported: () => boolean, new (options: { body: string, silent: boolean, title: string }): { on: (event: string, listener: () => void) => void, show: () => void } }} deps.electron.Notification
 * @param {{ openExternal: (url: string) => unknown, openPath: (path: string) => Promise<string>, showItemInFolder: (path: string) => void }} deps.electron.shell
 * @param {(name: "pictures") => string} deps.getPath
 * @param {{ exists: (path: string) => boolean, writeFile: (path: string, contents: string) => Promise<void> }} deps.files
 * @param {ReturnType<typeof import("./theme-store.js").createThemeStore>} deps.themes
 * @param {() => boolean} deps.systemPrefersDark
 * @param {() => string} deps.hostname The OS host name, for naming this
 *   desktop to a host it pairs with.
 * @param {{ loadWorkspace: () => unknown, saveWorkspaceChanges: (changes: unknown) => unknown }} deps.state
 * @param {{ connect: (options: { hostId: string, target: string, expectedIdentity?: { hostId: string, fingerprint?: string | null } | null }) => Promise<{ hostProtocolVersion: number, version?: string | null, hostId?: string | null, fingerprint?: string | null }>, disconnect: (hostId: string) => void, getState: (hostId: string) => unknown, forwardPort: (hostId: string, port: number) => unknown }} deps.sshHosts
 * @param {() => Promise<string[]>} deps.sshConfigHosts The aliases in the
 *   user's ssh config.
 * @param {{ answer: (promptId: unknown, answer: unknown) => void }} deps.sshPrompts
 * @param {{ update: (payload: unknown) => void, capturePage: (payload: unknown) => unknown }} deps.browserSessions
 * @param {{ detect: () => unknown, open: (options: { editorId: unknown, projectPath: unknown, sshTarget: unknown }) => unknown }} deps.editors
 * @param {(options: { chooseSavePath: (fileName: string) => Promise<string | null>, copyPng: (png: Uint8Array) => Promise<void>, webContents: unknown }) => Promise<{ status: string, filePath?: string }>} deps.captureAppScreenshot
 * @param {{ describe: () => unknown, restart: () => Promise<void> }} deps.homeHost
 *   How this desktop runs its home host: the mode now, and whether it
 *   started the host (desktop-host-mode.js, desktop-host.js).
 */
export const createDesktopHandlers = ({
  browserSessions,
  captureAppScreenshot,
  editors,
  electron: { ClipboardItem, clipboard, dialog, Notification, shell },
  files,
  getPath,
  getWindow,
  homeHost,
  hostname,
  sendToRenderer,
  sshConfigHosts,
  sshHosts,
  sshPrompts,
  state,
  systemPrefersDark,
  themes,
}) => {
  /**
   * Electron 44 removed clipboard.writeImage; images go through the
   * W3C-style clipboard.write([ClipboardItem]) API instead.
   * @param {Uint8Array} png
   */
  const writePngToClipboard = (png) =>
    clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([/** @type {BlobPart} */ (png)], {
          type: "image/png",
        }),
      }),
    ]);

  const paintWindowBackground = () => {
    getWindow()?.setBackgroundColor(
      themes.windowBackground(systemPrefersDark()),
    );
  };

  // Folder of the last saved screenshot, so the next Save dialog opens
  // there; starts in the user's Pictures folder, not kept across launches.
  /** @type {string | null} */
  let lastScreenshotDirectory = null;
  // Paths saved this session; "Show in folder" only reveals these.
  /** @type {Set<string>} */
  const savedScreenshotPaths = new Set();

  /** @param {string} defaultFileName */
  const chooseScreenshotSavePath = async (defaultFileName) => {
    const window = getWindow();
    if (!window) return null;
    const directory = lastScreenshotDirectory ?? getPath("pictures");
    const result = await dialog.showSaveDialog(window, {
      defaultPath: path.join(directory, defaultFileName),
      filters: [{ extensions: ["png"], name: "PNG image" }],
      title: "Save screenshot",
    });
    return result.canceled || !result.filePath ? null : result.filePath;
  };

  // Shown notifications are held until they close: a collected
  // notification never delivers its click.
  /** @type {Set<unknown>} */
  const shownNotifications = new Set();
  /** Code pairings waiting on the host, by the renderer's attempt id. */
  const codePairings = new Map();

  /** @satisfies {Partial<Record<DesktopMethod, (payload: any) => unknown>>} */
  const handlers = {
    openExternal: (/** @type {unknown} */ payload) => {
      const { url } = fields(payload);
      if (typeof url !== "string" || !url || !isHttpUrl(url)) return false;
      shell.openExternal(url);
      return true;
    },

    openPath: async (/** @type {unknown} */ payload) => {
      const { path: targetPath } = fields(payload);
      if (
        typeof targetPath !== "string" ||
        !targetPath ||
        !path.isAbsolute(targetPath)
      ) {
        return false;
      }
      return (await shell.openPath(targetPath)) === "";
    },

    writeClipboardText: (/** @type {unknown} */ payload) => {
      const { text } = fields(payload);
      if (typeof text !== "string") return false;
      clipboard.writeText(text);
      return true;
    },

    writeClipboardImage: async (/** @type {unknown} */ payload) => {
      const { png } = fields(payload);
      if (!isPngBytes(png)) return false;
      try {
        await writePngToClipboard(png);
        return true;
      } catch (error) {
        console.error("Failed to copy image to clipboard:", error);
        return false;
      }
    },

    saveTextFile: async (/** @type {unknown} */ payload) => {
      const { contents, defaultPath, title = "Save file" } = fields(payload);
      if (typeof contents !== "string") return false;
      const options = {
        defaultPath:
          typeof defaultPath === "string" && defaultPath.trim()
            ? defaultPath.trim()
            : undefined,
        title,
      };
      const window = getWindow();
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await files.writeFile(result.filePath, contents);
      return true;
    },

    captureAppScreenshot: async () => {
      const result = await captureAppScreenshot({
        chooseSavePath: chooseScreenshotSavePath,
        copyPng: writePngToClipboard,
        webContents: getWindow()?.webContents,
      });
      if (result.status === "saved" && result.filePath) {
        savedScreenshotPaths.add(result.filePath);
        lastScreenshotDirectory = path.dirname(result.filePath);
      }
      return result;
    },

    showScreenshotInFolder: (/** @type {unknown} */ payload) => {
      const { path: targetPath } = fields(payload);
      if (!savedScreenshotPaths.has(targetPath) || !files.exists(targetPath)) {
        return false;
      }
      shell.showItemInFolder(targetPath);
      return true;
    },

    showNotification: (/** @type {unknown} */ payload) => {
      const { body, chatId, silent, title } = fields(payload);
      if (
        typeof title !== "string" ||
        !title.trim() ||
        !Notification.isSupported()
      ) {
        return false;
      }

      const notification = new Notification({
        body: typeof body === "string" ? body.slice(0, 500) : "",
        silent: silent === true,
        title: title.slice(0, 200),
      });
      const release = () => shownNotifications.delete(notification);
      notification.on("click", () => {
        release();
        const window = getWindow();
        if (!window) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (typeof chatId === "string" && chatId) {
          sendToRenderer(DESKTOP_METHODS.onNotificationClicked.channel, {
            chatId,
          });
        }
      });
      notification.on("close", release);
      notification.on("failed", release);
      shownNotifications.add(notification);
      notification.show();
      return true;
    },

    // Window controls (the frameless window on Windows and Linux).
    windowMinimize: () => {
      getWindow()?.minimize();
    },
    windowMaximize: () => {
      const window = getWindow();
      if (window?.isMaximized()) window.unmaximize();
      else window?.maximize();
    },
    windowClose: () => {
      getWindow()?.close();
    },

    pickProjectDirectory: async () => {
      const window = getWindow();
      if (!window) return null;
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
        title: "Select project folder",
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0] ?? null;
    },

    // Read by the save worker, after every write queued before it: a
    // refreshed renderer sees what the old document saved.
    loadState: () => state.loadWorkspace(),
    saveWorkspaceChanges: (/** @type {unknown} */ changes) =>
      state.saveWorkspaceChanges(changes),

    getThemePreferences: () => themes.get(),
    setThemePreference: (/** @type {unknown} */ payload) => {
      themes.update({ theme: fields(payload).theme });
      paintWindowBackground();
      return true;
    },
    setBaseColor: (/** @type {unknown} */ payload) => {
      themes.update({ baseColor: fields(payload).baseColor });
      paintWindowBackground();
      return true;
    },
    setAccentColor: (/** @type {unknown} */ payload) => {
      themes.update({ accentColor: fields(payload).accentColor });
      return true;
    },

    pairHostWithCode: async (payload) => {
      const { address, code, attemptId, deviceName } = fields(payload);
      if (
        typeof address !== "string" ||
        address.length > 500 ||
        typeof code !== "string" ||
        code.length > 32 ||
        typeof attemptId !== "string" ||
        attemptId.length > 100 ||
        codePairings.has(attemptId) ||
        (deviceName !== undefined && typeof deviceName !== "string")
      )
        throw new Error(
          "A host address, pairing code and attempt id are required.",
        );
      const controller = new AbortController();
      codePairings.set(attemptId, controller);
      try {
        return await sshHosts.pairWithCode({
          address,
          code,
          signal: controller.signal,
          ...pairingIdentity(payload, desktopDeviceName(hostname())),
        });
      } finally {
        codePairings.delete(attemptId);
      }
    },
    cancelHostPairing: (payload) => {
      const { attemptId } = fields(payload);
      const controller =
        typeof attemptId === "string" ? codePairings.get(attemptId) : null;
      controller?.abort(new Error("Pairing was cancelled."));
      return Boolean(controller);
    },
    forgetHostCredential: (payload) => {
      const { credentialId } = fields(payload);
      if (typeof credentialId !== "string")
        throw new Error("A device credential id is required.");
      sshHosts.forgetCredential(credentialId);
      return true;
    },
    connectHost: async (/** @type {unknown} */ payload) => {
      const {
        expectedHostId,
        expectedFingerprint,
        hostId,
        target,
        sshRoutes,
        routes: configuredRoutes,
      } = fields(payload);
      if (
        typeof hostId !== "string" ||
        (!configuredRoutes && (typeof target !== "string" || !target.trim()))
      ) {
        throw new Error("A host needs an id and an SSH target.");
      }
      let routes;
      if (configuredRoutes !== undefined) {
        if (
          !Array.isArray(configuredRoutes) ||
          !configuredRoutes.length ||
          configuredRoutes.length > MAX_HOST_ROUTES
        )
          throw new Error(
            `A connection needs between 1 and ${MAX_HOST_ROUTES} routes.`,
          );
        routes = configuredRoutes.map((route) => {
          if (typeof route?.id !== "string" || !route.id.trim())
            throw new Error("A route needs an id.");
          if (
            route.kind === "https" &&
            typeof route.origin === "string" &&
            typeof route.credentialId === "string"
          )
            return {
              id: route.id,
              kind: "https",
              origin: route.origin,
              credentialId: route.credentialId,
            };
          if (
            route.kind === "ssh" &&
            typeof route.target === "string" &&
            route.target.trim()
          )
            return {
              id: route.id,
              kind: "ssh",
              target: route.target.trim(),
            };
          throw new Error(
            "Each route needs an SSH target or paired HTTPS origin.",
          );
        });
        if (new Set(routes.map((route) => route.id)).size !== routes.length)
          throw new Error("Route ids must be distinct.");
      }
      if (sshRoutes !== undefined) {
        if (
          !Array.isArray(sshRoutes) ||
          sshRoutes.length === 0 ||
          sshRoutes.length > MAX_HOST_ROUTES
        )
          throw new Error(
            `A connection needs between 1 and ${MAX_HOST_ROUTES} SSH routes.`,
          );
        routes = sshRoutes.map((route) => {
          if (
            typeof route?.id !== "string" ||
            !route.id.trim() ||
            typeof route?.target !== "string" ||
            !route.target.trim()
          )
            throw new Error("Each SSH route needs a distinct id and target.");
          return {
            id: route.id.trim(),
            target: route.target.trim(),
          };
        });
        if (new Set(routes.map((route) => route.id)).size !== routes.length)
          throw new Error("Each SSH route needs a distinct id.");
      }
      const endpoint = await sshHosts.connect({
        ...(routes
          ? configuredRoutes
            ? { routes }
            : { sshRoutes: routes }
          : {}),
        hostId,
        target: typeof target === "string" ? target.trim() : undefined,
        expectedIdentity:
          typeof expectedHostId === "string" && expectedHostId
            ? {
                fingerprint:
                  typeof expectedFingerprint === "string"
                    ? expectedFingerprint
                    : null,
                hostId: expectedHostId,
              }
            : null,
      });
      // The token stays in this process; the renderer goes through the proxy.
      return {
        ...(endpoint.routeId
          ? {
              routeId: endpoint.routeId,
              routes: sshHosts.getRouteState?.(hostId)?.routes,
            }
          : {}),
        fingerprint: endpoint.fingerprint ?? null,
        hostId: endpoint.hostId ?? null,
        hostProtocolVersion: endpoint.hostProtocolVersion,
        version: endpoint.version ?? null,
      };
    },
    listSshConfigHosts: () => sshConfigHosts(),
    getHomeHostSettings: () => homeHost.describe(),
    restartHomeHost: async () => {
      await homeHost.restart();
      return homeHost.describe();
    },
    disconnectHost: (/** @type {unknown} */ payload) => {
      const { hostId } = fields(payload);
      if (typeof hostId === "string") sshHosts.disconnect(hostId);
      return true;
    },
    getHostState: (/** @type {unknown} */ payload) => {
      const { hostId } = fields(payload);
      return typeof hostId === "string" ? sshHosts.getState(hostId) : "idle";
    },
    // A port on an SSH host (its dev server) forwarded here, for the
    // browser panel; resolves with the local port.
    forwardHostPort: (/** @type {unknown} */ payload) => {
      const { hostId, port } = fields(payload);
      const remotePort = Number(port);
      if (
        typeof hostId !== "string" ||
        !Number.isInteger(remotePort) ||
        remotePort < 1 ||
        remotePort > 65_535
      ) {
        throw new Error("A host and a port are needed.");
      }
      return sshHosts.forwardPort(hostId, remotePort);
    },
    answerHostPrompt: (/** @type {unknown} */ payload) => {
      const { answer, promptId } = fields(payload);
      sshPrompts.answer(promptId, answer);
    },

    updateBrowser: (/** @type {unknown} */ payload) => {
      browserSessions.update(payload);
    },
    captureBrowserPage: (/** @type {unknown} */ payload) =>
      browserSessions.capturePage(payload),

    detectEditors: () => editors.detect(),
    openInEditor: (/** @type {unknown} */ payload) => {
      const { editorId, projectPath, sshTarget, hostId } = fields(payload);
      if (hostId && (typeof sshTarget !== "string" || !sshTarget.trim()))
        return false;
      return editors.open({ editorId, projectPath, sshTarget });
    },
  };

  return { handlers, paintWindowBackground };
};

/**
 * Puts each handler on its method's channel: an `invoke` method answers,
 * a `send` method only listens.
 * @param {{ handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown) => void, on: (channel: string, listener: (event: unknown, payload: unknown) => void) => void }} ipcMain
 * @param {Partial<Record<DesktopMethod, (payload: any) => unknown>>} handlers
 */
export const registerDesktopHandlers = (ipcMain, handlers) => {
  for (const [method, handler] of Object.entries(handlers)) {
    const spec = DESKTOP_METHODS[/** @type {DesktopMethod} */ (method)];
    if (!spec || spec.kind === "subscribe" || !handler) {
      throw new Error(`${method} is not a desktop method the renderer calls.`);
    }
    if (spec.kind === "invoke") {
      ipcMain.handle(spec.channel, (_event, payload) => handler(payload));
    } else {
      ipcMain.on(spec.channel, (_event, payload) => {
        handler(payload);
      });
    }
  }
};
