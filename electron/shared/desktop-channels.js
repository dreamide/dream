// @ts-check
// The desktop bridge's methods (`window.dream`, typed as `DesktopApi` in
// src/types/ide.ts) and the IPC channel each one travels on, in one table.
// The preload builds `window.dream` from it, the development fixture builds
// the same object over a fake transport, and the main process registers its
// handlers by it (desktop-handlers.js), so a channel's name is written here
// only. A new desktop method is a row here, its signature in `DesktopApi`,
// and its handler.
//
// A row is one of:
//   invoke     the renderer asks and awaits an answer (ipcRenderer.invoke);
//   send       the renderer tells, with no answer (ipcRenderer.send);
//   subscribe  the main process tells the renderer (webContents.send); the
//              method takes a listener and answers an unsubscribe.
//
// `params` names the method's arguments, which travel as one object
// (`forwardHostPort(hostId, port)` sends `{ hostId, port }`). Without
// `params`, the method's one argument is sent as it is.

/**
 * @typedef {{ kind: "invoke" | "send", channel: string, params?: readonly string[] }
 *   | { kind: "subscribe", channel: string }} DesktopMethodSpec
 */

export const DESKTOP_METHODS =
  /** @satisfies {Record<string, DesktopMethodSpec>} */ ({
    openExternal: {
      channel: "shell:open-external",
      kind: "invoke",
      params: ["url"],
    },
    openPath: { channel: "shell:open-path", kind: "invoke", params: ["path"] },
    writeClipboardText: {
      channel: "clipboard:write-text",
      kind: "invoke",
      params: ["text"],
    },
    writeClipboardImage: {
      channel: "clipboard:write-image",
      kind: "invoke",
      params: ["png"],
    },
    saveTextFile: { channel: "files:save-text", kind: "invoke" },

    captureAppScreenshot: {
      channel: "app:capture-screenshot",
      kind: "invoke",
      params: [],
    },
    showScreenshotInFolder: {
      channel: "app:show-screenshot-in-folder",
      kind: "invoke",
      params: ["path"],
    },
    onAppScreenshotRequested: {
      channel: "app:screenshot-requested",
      kind: "subscribe",
    },

    showNotification: { channel: "notifications:show", kind: "invoke" },
    onNotificationClicked: {
      channel: "notifications:clicked",
      kind: "subscribe",
    },

    windowMinimize: { channel: "window:minimize", kind: "invoke", params: [] },
    windowMaximize: { channel: "window:maximize", kind: "invoke", params: [] },
    windowClose: { channel: "window:close", kind: "invoke", params: [] },

    pickProjectDirectory: {
      channel: "projects:pick-directory",
      kind: "invoke",
      params: [],
    },

    loadState: { channel: "state:load", kind: "invoke", params: [] },
    saveWorkspaceChanges: { channel: "state:save-workspace", kind: "invoke" },
    getThemePreferences: {
      channel: "theme:get-preferences",
      kind: "invoke",
      params: [],
    },
    setThemePreference: {
      channel: "theme:set",
      kind: "invoke",
      params: ["theme"],
    },
    setBaseColor: {
      channel: "theme:set-base-color",
      kind: "invoke",
      params: ["baseColor"],
    },
    setAccentColor: {
      channel: "theme:set-accent-color",
      kind: "invoke",
      params: ["accentColor"],
    },

    // Terminals are served by the host (src/lib/terminal-client.ts), not IPC.

    // SSH hosts: connecting, their state, and ssh's prompts.
    connectHost: { channel: "hosts:connect", kind: "invoke" },
    pairHost: { channel: "hosts:pair", kind: "invoke" },
    pairHostWithCode: { channel: "hosts:pair-with-code", kind: "invoke" },
    cancelHostPairing: {
      channel: "hosts:cancel-pairing",
      kind: "invoke",
      params: ["attemptId"],
    },
    forgetHostCredential: {
      channel: "hosts:forget-credential",
      kind: "invoke",
      params: ["credentialId"],
    },
    disconnectHost: {
      channel: "hosts:disconnect",
      kind: "invoke",
      params: ["hostId"],
    },
    getHostState: {
      channel: "hosts:state",
      kind: "invoke",
      params: ["hostId"],
    },
    forwardHostPort: {
      channel: "hosts:forward-port",
      kind: "invoke",
      params: ["hostId", "port"],
    },
    listSshConfigHosts: {
      channel: "hosts:ssh-config-hosts",
      kind: "invoke",
      params: [],
    },
    onHostStatus: { channel: "hosts:status", kind: "subscribe" },
    onHostPrompt: { channel: "hosts:prompt", kind: "subscribe" },
    answerHostPrompt: {
      channel: "hosts:prompt-answer",
      kind: "send",
      params: ["promptId", "answer"],
    },

    updateBrowser: { channel: "browser:update", kind: "send" },
    captureBrowserPage: { channel: "browser:capture-page", kind: "invoke" },
    onBrowserError: { channel: "browser:error", kind: "subscribe" },
    // Agent browser control: the renderer registers mounted <webview> guests
    // and answers commands (open/activate/close tab) that only it can perform.
    reportBrowserGuestAttached: {
      channel: "browser:guest-attached",
      kind: "send",
    },
    reportBrowserGuestDetached: {
      channel: "browser:guest-detached",
      kind: "send",
    },
    onBrowserCommand: { channel: "browser:command", kind: "subscribe" },
    onBrowserAgentActivity: {
      channel: "browser:agent-activity",
      kind: "subscribe",
    },
    sendBrowserCommandResult: {
      channel: "browser:command-result",
      kind: "send",
    },

    // The home host: how this desktop runs it (desktop-host-preference.js).
    getHomeHostSettings: {
      channel: "home-host:get-settings",
      kind: "invoke",
      params: [],
    },
    setHomeHostPreference: {
      channel: "home-host:set-preference",
      kind: "invoke",
    },
    restartHomeHost: {
      channel: "home-host:restart",
      kind: "invoke",
      params: [],
    },
    relaunchApp: { channel: "app:relaunch", kind: "invoke", params: [] },
    listWslDistributions: {
      channel: "hosts:wsl-distributions",
      kind: "invoke",
      params: [],
    },

    detectEditors: { channel: "editors:detect", kind: "invoke", params: [] },
    openInEditor: { channel: "editors:open", kind: "invoke" },

    getUpdateStatus: {
      channel: "updates:get-status",
      kind: "invoke",
      params: [],
    },
    checkForUpdates: { channel: "updates:check", kind: "invoke", params: [] },
    installUpdate: { channel: "updates:install", kind: "invoke", params: [] },
    onUpdateStatus: { channel: "updates:status", kind: "subscribe" },
  });

/** @typedef {keyof typeof DESKTOP_METHODS} DesktopMethod */

/**
 * The values the preload reads synchronously, before the page runs.
 */
export const DESKTOP_SYNC_CHANNELS = {
  hostMode: "host:get-mode",
  apiSessionToken: "api:get-session-token",
  initialThemePreferences: "theme:get-initial-preferences",
};

/**
 * The channel `method` travels on.
 * @param {DesktopMethod} method
 * @returns {string}
 */
export const desktopChannel = (method) => DESKTOP_METHODS[method].channel;

/**
 * The payload a call of `spec` with `args` sends.
 * @param {DesktopMethodSpec} spec
 * @param {unknown[]} args
 * @returns {unknown}
 */
export const desktopPayload = (spec, args) => {
  if (spec.kind === "subscribe") return undefined;
  if (!spec.params) return args[0];
  if (spec.params.length === 0) return undefined;
  return Object.fromEntries(
    spec.params.map((name, index) => [name, args[index]]),
  );
};

/**
 * @typedef {object} DesktopTransport
 * @property {(channel: string, payload: unknown) => unknown} invoke
 * @property {(channel: string, payload: unknown) => void} send
 * @property {(channel: string, listener: (payload: unknown) => void) => () => void} subscribe
 */

/**
 * Every desktop method, over `transport`: `window.dream`'s methods in the
 * preload, a fake's in the fixture.
 * @param {DesktopTransport} transport
 * @returns {Record<DesktopMethod, (...args: any[]) => unknown>}
 */
export const createDesktopMethods = (transport) =>
  /** @type {Record<DesktopMethod, (...args: any[]) => unknown>} */ (
    Object.fromEntries(
      Object.entries(DESKTOP_METHODS).map(([method, spec]) => {
        if (spec.kind === "subscribe") {
          return [
            method,
            /** @param {(payload: unknown) => void} listener */
            (listener) => transport.subscribe(spec.channel, listener),
          ];
        }
        const call = spec.kind === "invoke" ? transport.invoke : transport.send;
        return [
          method,
          /** @param {unknown[]} args */
          (...args) => call(spec.channel, desktopPayload(spec, args)),
        ];
      }),
    )
  );
