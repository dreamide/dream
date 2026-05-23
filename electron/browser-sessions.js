import { writeFile } from "node:fs/promises";
import { dialog, shell, WebContentsView } from "electron";

const MIN_ZOOM_FACTOR = 0.25;
const MAX_ZOOM_FACTOR = 3;
const DEFAULT_ZOOM_FACTOR = 1;

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value.trim());
}

function getAlternateLoopbackUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();

    if (host === "localhost") {
      parsed.hostname = "127.0.0.1";
      return parsed.toString();
    }

    if (host === "127.0.0.1") {
      parsed.hostname = "localhost";
      return parsed.toString();
    }
  } catch {
    // ignore parse failures
  }

  return null;
}

function getBrowserLoadCandidates(value) {
  const primary = value.trim();
  const alternate = getAlternateLoopbackUrl(primary);

  if (!alternate || alternate === primary) {
    return [primary];
  }

  return [primary, alternate];
}

function clampZoomFactor(value) {
  if (!Number.isFinite(value)) {
    return DEFAULT_ZOOM_FACTOR;
  }

  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, value));
}

function getSafeScreenshotName(value) {
  const base =
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : "browser-screenshot";
  const sanitized = base
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return `${sanitized || "browser-screenshot"}.png`;
}

export function createBrowserSessionManager({ getMainWindow, sendToRenderer }) {
  let activeBrowserTabId = null;
  const browserSessions = new Map();
  const browserState = {
    bounds: { height: 0, width: 0, x: 0, y: 0 },
    projectId: null,
    tabId: null,
    reload: false,
    visible: false,
    url: "about:blank",
  };

  function getBrowserPageState(session) {
    if (!session) {
      return null;
    }

    const { webContents } = session.view;
    const navigationHistory = webContents.navigationHistory;
    const currentUrl =
      session.failedRequestedUrl ||
      webContents.getURL() ||
      session.currentLoadedUrl ||
      session.currentRequestedUrl ||
      "about:blank";

    return {
      canGoBack: navigationHistory?.canGoBack() ?? false,
      canGoForward: navigationHistory?.canGoForward() ?? false,
      projectId: session.projectId,
      tabId: session.tabId,
      title: webContents.getTitle() || session.title || "New Tab",
      url: currentUrl,
      zoomFactor: getSessionZoomFactor(session),
    };
  }

  function sendBrowserActionError(session, code, description) {
    sendToRenderer("browser:error", {
      code,
      description,
      projectId: session?.projectId ?? browserState.projectId,
      tabId: session?.tabId ?? browserState.tabId,
    });
  }

  function getExistingBrowserSession(
    tabId = browserState.tabId,
    projectId = browserState.projectId,
    actionName = "browser action",
  ) {
    const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
    if (!normalizedTabId) {
      sendBrowserActionError(
        null,
        "BROWSER_ACTION_FAILED",
        `No active browser tab found for ${actionName}.`,
      );
      return null;
    }

    const session = browserSessions.get(normalizedTabId);
    if (!session) {
      sendBrowserActionError(
        null,
        "BROWSER_ACTION_FAILED",
        `Browser tab is not ready for ${actionName} yet.`,
      );
      return null;
    }

    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (normalizedProjectId) {
      session.projectId = normalizedProjectId;
    }

    return session;
  }

  function getSessionZoomFactor(session) {
    try {
      return session.view.webContents.getZoomFactor();
    } catch {
      return session.zoomFactor ?? DEFAULT_ZOOM_FACTOR;
    }
  }

  function setBrowserZoomFactor(session, zoomFactor) {
    const nextZoomFactor = clampZoomFactor(zoomFactor);
    try {
      session.view.webContents.setZoomFactor(nextZoomFactor);
      session.zoomFactor = nextZoomFactor;
      sendBrowserPageState(session);
    } catch {
      sendBrowserActionError(
        session,
        "ZOOM_FAILED",
        "Failed to update browser zoom.",
      );
    }
  }

  function sendBrowserPageState(session) {
    const pageState = getBrowserPageState(session);
    if (!pageState) {
      return;
    }

    sendToRenderer("browser:page-state", pageState);
  }

  function settleBrowserLoadFailure(session, failedUrl) {
    if (!session) {
      return;
    }

    const nextRequestedUrl =
      (typeof session.loadingRequestedUrl === "string" &&
      session.loadingRequestedUrl.trim().length > 0
        ? session.loadingRequestedUrl.trim()
        : null) ||
      (typeof session.currentRequestedUrl === "string" &&
      session.currentRequestedUrl.trim().length > 0
        ? session.currentRequestedUrl.trim()
        : null) ||
      (typeof failedUrl === "string" && failedUrl.trim().length > 0
        ? failedUrl.trim()
        : null) ||
      session.currentLoadedUrl ||
      "about:blank";

    session.loadingRequestedUrl = null;
    session.currentRequestedUrl = nextRequestedUrl;
    session.failedRequestedUrl = nextRequestedUrl;

    if (
      typeof session.currentLoadedUrl !== "string" ||
      session.currentLoadedUrl.trim().length === 0
    ) {
      session.currentLoadedUrl = "about:blank";
    }
  }

  function createBrowserSession(tabId, projectId) {
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
      },
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) {
        shell.openExternal(url);
      }
      return { action: "deny" };
    });

    view.webContents.on("did-start-loading", () => {
      sendToRenderer("browser:status", {
        loading: true,
        projectId,
        tabId,
      });
    });

    view.webContents.on("did-finish-load", () => {
      const session = browserSessions.get(tabId);
      if (session) {
        session.loadingRequestedUrl = null;
        session.currentLoadedUrl =
          session.view.webContents.getURL() || "about:blank";
        session.currentRequestedUrl = session.currentLoadedUrl;
        session.failedRequestedUrl = null;
        session.title = session.view.webContents.getTitle() || session.title;
      }

      sendBrowserPageState(browserSessions.get(tabId));
    });

    view.webContents.on("did-stop-loading", () => {
      const session = browserSessions.get(tabId);
      if (
        session &&
        !session.failedRequestedUrl &&
        session.view.webContents.getURL() !== "about:blank"
      ) {
        session.loadingRequestedUrl = null;
        session.currentLoadedUrl = session.view.webContents.getURL();
        session.currentRequestedUrl = session.currentLoadedUrl;
        session.failedRequestedUrl = null;
        session.title = session.view.webContents.getTitle() || session.title;
      }

      sendToRenderer("browser:status", {
        loading: false,
        projectId,
        tabId,
      });
      sendBrowserPageState(browserSessions.get(tabId));
    });

    view.webContents.on("did-navigate", (_event, url) => {
      const session = browserSessions.get(tabId);
      if (!session) {
        return;
      }

      session.currentLoadedUrl = url || session.currentLoadedUrl;
      session.currentRequestedUrl = session.currentLoadedUrl;
      session.failedRequestedUrl = null;
      session.title = session.view.webContents.getTitle() || session.title;
      sendBrowserPageState(session);
    });

    view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }

      const session = browserSessions.get(tabId);
      if (!session) {
        return;
      }

      session.currentLoadedUrl = url || session.currentLoadedUrl;
      session.currentRequestedUrl = session.currentLoadedUrl;
      session.failedRequestedUrl = null;
      session.title = session.view.webContents.getTitle() || session.title;
      sendBrowserPageState(session);
    });

    view.webContents.on("page-title-updated", (_event, title) => {
      const session = browserSessions.get(tabId);
      if (!session) {
        return;
      }

      session.title = title || session.title;
      sendBrowserPageState(session);
    });

    view.webContents.on(
      "did-fail-load",
      (_event, code, description, validatedUrl, isMainFrame) => {
        if (!isMainFrame) {
          return;
        }

        if (code === -3) {
          return;
        }

        const session = browserSessions.get(tabId);
        settleBrowserLoadFailure(session, validatedUrl);
        sendBrowserPageState(session);

        if (browserState.tabId !== tabId) {
          return;
        }

        sendToRenderer("browser:error", {
          code,
          description,
        });
      },
    );

    return {
      attached: false,
      currentLoadedUrl: "about:blank",
      currentRequestedUrl: "about:blank",
      failedRequestedUrl: null,
      lastBounds: null,
      loadRequestId: 0,
      loadingRequestedUrl: null,
      projectId,
      tabId,
      title: "New Tab",
      view,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
    };
  }

  function getBrowserSession(tabId, projectId) {
    const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
    const normalizedProjectId =
      typeof projectId === "string" ? projectId.trim() : "";
    if (!normalizedTabId) {
      return null;
    }

    const existing = browserSessions.get(normalizedTabId);
    if (existing) {
      if (normalizedProjectId) {
        existing.projectId = normalizedProjectId;
      }
      return existing;
    }

    const created = createBrowserSession(normalizedTabId, normalizedProjectId);
    browserSessions.set(normalizedTabId, created);
    return created;
  }

  function attachBrowserSession(session) {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed() || !session) {
      return;
    }

    mainWindow.contentView.addChildView(session.view);
    if (!session.attached) {
      session.attached = true;
    }
  }

  function detachBrowserSession(session) {
    const mainWindow = getMainWindow();
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      !session ||
      !session.attached
    ) {
      return;
    }

    mainWindow.contentView.removeChildView(session.view);
    session.attached = false;
  }

  function detachAllBrowserSessions() {
    for (const session of browserSessions.values()) {
      detachBrowserSession(session);
    }
  }

  function hideForRendererNavigation() {
    detachAllBrowserSessions();
    activeBrowserTabId = null;
    browserState.visible = false;
    browserState.reload = false;
  }

  function stopNavigation(
    tabId = browserState.tabId,
    projectId = browserState.projectId,
  ) {
    const session = getBrowserSession(tabId, projectId);
    if (!session) {
      return;
    }

    session.loadRequestId += 1;
    session.loadingRequestedUrl = null;
    session.currentRequestedUrl = session.currentLoadedUrl || "about:blank";

    try {
      session.view.webContents.stop();
    } catch {
      // ignore stop failures
    }

    sendToRenderer("browser:status", {
      loading: false,
      projectId: session.projectId,
      tabId: session.tabId,
    });
  }

  function navigateHistory(
    direction,
    tabId = browserState.tabId,
    projectId = browserState.projectId,
  ) {
    const session = getBrowserSession(tabId, projectId);
    if (!session) {
      return;
    }

    try {
      const navigationHistory = session.view.webContents.navigationHistory;

      if (direction === "back" && navigationHistory?.canGoBack()) {
        session.view.webContents.goBack();
      } else if (direction === "forward" && navigationHistory?.canGoForward()) {
        session.view.webContents.goForward();
      }
    } catch {
      // ignore history navigation failures
    }

    sendBrowserPageState(session);
  }

  function applyState() {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const { bounds, projectId, tabId, url, visible } = browserState;
    const canRender =
      visible &&
      typeof projectId === "string" &&
      projectId.trim().length > 0 &&
      typeof tabId === "string" &&
      tabId.trim().length > 0 &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      isHttpUrl(url);

    if (!canRender) {
      detachAllBrowserSessions();
      if (typeof tabId === "string" && tabId.trim().length > 0) {
        sendToRenderer("browser:status", {
          loading: false,
          projectId,
          tabId,
        });
      }
      activeBrowserTabId = null;
      return;
    }

    const nextSession = getBrowserSession(tabId, projectId);
    if (!nextSession) {
      return;
    }

    const roundedBounds = {
      height: Math.round(bounds.height),
      width: Math.round(bounds.width),
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
    };
    const currentProjectSessions = [];

    for (const session of browserSessions.values()) {
      if (session.projectId === projectId) {
        currentProjectSessions.push(session);
        continue;
      }

      detachBrowserSession(session);
    }

    for (const session of currentProjectSessions) {
      if (session.tabId === nextSession.tabId) {
        continue;
      }

      attachBrowserSession(session);
      session.view.setBounds(roundedBounds);
      session.lastBounds = roundedBounds;
    }

    attachBrowserSession(nextSession);
    nextSession.view.setBounds(roundedBounds);
    nextSession.lastBounds = roundedBounds;
    activeBrowserTabId = nextSession.tabId;

    const forceReload = browserState.reload;
    browserState.reload = false;

    if (
      (!forceReload && nextSession.failedRequestedUrl === url) ||
      (!forceReload && nextSession.currentRequestedUrl === url) ||
      nextSession.loadingRequestedUrl === url
    ) {
      return;
    }

    if (
      forceReload &&
      nextSession.currentRequestedUrl === url &&
      nextSession.currentLoadedUrl !== "about:blank" &&
      !nextSession.loadingRequestedUrl
    ) {
      nextSession.loadingRequestedUrl = url;

      try {
        nextSession.view.webContents.reloadIgnoringCache();
      } catch (error) {
        nextSession.loadingRequestedUrl = null;
        sendToRenderer("browser:error", {
          code: "RELOAD_FAILED",
          description: error instanceof Error ? error.message : "Unknown error",
        });
        sendToRenderer("browser:status", {
          loading: false,
          projectId: nextSession.projectId,
          tabId: nextSession.tabId,
        });
      }

      return;
    }

    nextSession.currentRequestedUrl = url;
    nextSession.loadingRequestedUrl = url;
    nextSession.failedRequestedUrl = null;
    const requestId = ++nextSession.loadRequestId;
    const candidates = getBrowserLoadCandidates(url);

    const loadCandidate = async (index = 0) => {
      if (requestId !== nextSession.loadRequestId) {
        return;
      }

      const candidate = candidates[index];
      if (!candidate) {
        if (requestId !== nextSession.loadRequestId) {
          return;
        }

        settleBrowserLoadFailure(nextSession, url);
        nextSession.currentRequestedUrl = url;
        nextSession.failedRequestedUrl = url;
        sendBrowserPageState(nextSession);

        if (browserState.tabId === nextSession.tabId) {
          sendToRenderer("browser:error", {
            code: "LOAD_URL_FAILED",
            description: "Failed to load browser URL.",
          });
        }

        return;
      }

      nextSession.loadingRequestedUrl = candidate;

      try {
        await nextSession.view.webContents.loadURL(candidate);

        if (requestId !== nextSession.loadRequestId) {
          return;
        }

        nextSession.loadingRequestedUrl = null;
        nextSession.currentRequestedUrl = candidate;
        nextSession.currentLoadedUrl = candidate;
        nextSession.title =
          nextSession.view.webContents.getTitle() || nextSession.title;
        sendBrowserPageState(nextSession);
      } catch (error) {
        if (requestId !== nextSession.loadRequestId) {
          return;
        }

        if (index + 1 < candidates.length) {
          await loadCandidate(index + 1);
          return;
        }

        settleBrowserLoadFailure(nextSession, url);
        nextSession.currentRequestedUrl = url;
        nextSession.failedRequestedUrl = url;
        sendBrowserPageState(nextSession);

        if (browserState.tabId === nextSession.tabId) {
          sendToRenderer("browser:error", {
            code: "LOAD_URL_FAILED",
            description:
              error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    };

    void loadCandidate();
  }

  function destroyTab(tabId) {
    const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
    if (!normalizedTabId) return;

    const session = browserSessions.get(normalizedTabId);
    if (!session) return;

    detachBrowserSession(session);

    try {
      session.view.webContents.close();
    } catch {
      // ignore close failures
    }

    browserSessions.delete(normalizedTabId);

    if (activeBrowserTabId === normalizedTabId) {
      activeBrowserTabId = null;
    }

    if (browserState.tabId === normalizedTabId) {
      browserState.tabId = null;
      browserState.url = "about:blank";
    }
  }

  function openDevTools(
    tabId = browserState.tabId,
    projectId = browserState.projectId,
  ) {
    const normalizedTabId = typeof tabId === "string" ? tabId.trim() : "";
    if (!normalizedTabId) {
      sendToRenderer("browser:error", {
        code: "DEVTOOLS_FAILED",
        description: "No active browser tab found for DevTools.",
      });
      return;
    }

    const session = browserSessions.get(normalizedTabId);
    if (!session) {
      sendToRenderer("browser:error", {
        code: "DEVTOOLS_FAILED",
        description: "Browser tab is not ready for DevTools yet.",
      });
      return;
    }

    attachBrowserSession(session);

    try {
      session.view.webContents.openDevTools({
        activate: true,
        mode: "undocked",
        title: session.title ? `DevTools - ${session.title}` : "DevTools",
      });
    } catch {
      try {
        session.view.webContents.openDevTools();
      } catch {
        sendToRenderer("browser:error", {
          code: "DEVTOOLS_FAILED",
          description: "Failed to open DevTools.",
          projectId,
          tabId: normalizedTabId,
        });
      }
    }
  }

  async function clearBrowserCookies(tabId, projectId) {
    const session = getExistingBrowserSession(tabId, projectId, "cookies");
    if (!session) {
      return;
    }

    try {
      await session.view.webContents.session.clearStorageData({
        storages: ["cookies"],
      });
    } catch {
      sendBrowserActionError(
        session,
        "CLEAR_COOKIES_FAILED",
        "Failed to clear browser cookies.",
      );
    }
  }

  async function clearBrowserCache(tabId, projectId) {
    const session = getExistingBrowserSession(tabId, projectId, "cache");
    if (!session) {
      return;
    }

    try {
      await session.view.webContents.session.clearCache();
    } catch {
      sendBrowserActionError(
        session,
        "CLEAR_CACHE_FAILED",
        "Failed to clear browser cache.",
      );
    }
  }

  async function takeBrowserScreenshot(tabId, projectId) {
    const session = getExistingBrowserSession(tabId, projectId, "screenshot");
    if (!session) {
      return;
    }

    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      sendBrowserActionError(
        session,
        "SCREENSHOT_FAILED",
        "No app window is available for saving the screenshot.",
      );
      return;
    }

    try {
      const image = await session.view.webContents.capturePage();
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: getSafeScreenshotName(session.title),
        filters: [{ name: "PNG image", extensions: ["png"] }],
        title: "Save browser screenshot",
      });

      if (result.canceled || !result.filePath) {
        return;
      }

      await writeFile(result.filePath, image.toPNG());
    } catch {
      sendBrowserActionError(
        session,
        "SCREENSHOT_FAILED",
        "Failed to save browser screenshot.",
      );
    }
  }

  function reset() {
    detachAllBrowserSessions();
    activeBrowserTabId = null;
    browserState.projectId = null;
    browserState.tabId = null;
  }

  function update(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }

    if (
      typeof payload.projectId === "string" &&
      payload.projectId.trim().length > 0
    ) {
      browserState.projectId = payload.projectId.trim();
    }

    if (typeof payload.tabId === "string" && payload.tabId.trim().length > 0) {
      browserState.tabId = payload.tabId.trim();
    }

    if (typeof payload.destroyTab === "string") {
      destroyTab(payload.destroyTab);
      return;
    }

    if (payload.openDevTools === true) {
      openDevTools(payload.tabId ?? browserState.tabId, browserState.projectId);
      return;
    }

    if (payload.takeScreenshot === true) {
      void takeBrowserScreenshot(
        payload.tabId ?? browserState.tabId,
        browserState.projectId,
      );
      return;
    }

    if (payload.clearCookies === true) {
      void clearBrowserCookies(
        payload.tabId ?? browserState.tabId,
        browserState.projectId,
      );
      return;
    }

    if (payload.clearCache === true) {
      void clearBrowserCache(
        payload.tabId ?? browserState.tabId,
        browserState.projectId,
      );
      return;
    }

    if (payload.resetZoom === true || typeof payload.zoomDelta === "number") {
      const session = getExistingBrowserSession(
        payload.tabId ?? browserState.tabId,
        browserState.projectId,
        "zoom",
      );
      if (session) {
        const currentZoomFactor = getSessionZoomFactor(session);
        setBrowserZoomFactor(
          session,
          payload.resetZoom === true
            ? DEFAULT_ZOOM_FACTOR
            : currentZoomFactor + payload.zoomDelta,
        );
      }
      return;
    }

    if (payload.goBack === true) {
      navigateHistory("back");
      return;
    }

    if (payload.goForward === true) {
      navigateHistory("forward");
      return;
    }

    if (payload.stop === true) {
      stopNavigation();
      return;
    }

    const nextBounds = payload.bounds;
    if (nextBounds && typeof nextBounds === "object") {
      browserState.bounds = {
        height: Number(nextBounds.height ?? browserState.bounds.height),
        width: Number(nextBounds.width ?? browserState.bounds.width),
        x: Number(nextBounds.x ?? browserState.bounds.x),
        y: Number(nextBounds.y ?? browserState.bounds.y),
      };
    }

    if (typeof payload.visible === "boolean") {
      browserState.visible = payload.visible;
    }

    if (payload.reload === true) {
      browserState.reload = true;
    }

    if (typeof payload.url === "string" && payload.url.trim().length > 0) {
      browserState.url = payload.url.trim();
    }

    applyState();
  }

  return {
    applyState,
    hideForRendererNavigation,
    reset,
    update,
  };
}
