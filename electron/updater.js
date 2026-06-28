import { createRequire } from "node:module";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;
const require = createRequire(import.meta.url);
const updaterRequire = createRequire(require.resolve("electron-updater"));
const updaterSemver = updaterRequire("semver");

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const INITIAL_UPDATE_CHECK_DELAY_MS = 5000;

function nowIsoString() {
  return new Date().toISOString();
}

function getUpdateVersion(info) {
  return typeof info?.version === "string" && info.version.trim()
    ? info.version.trim()
    : null;
}

function getUpdateReleaseDate(info) {
  return typeof info?.releaseDate === "string" && info.releaseDate.trim()
    ? info.releaseDate.trim()
    : null;
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return "Update check failed.";
}

function getUpdateFeedUrl() {
  const url = process.env.DREAM_UPDATE_FEED_URL?.trim();

  return url ? url.replace(/\/+$/, "") : null;
}

function getDevUpdateCurrentVersion() {
  const version = process.env.DREAM_DEV_UPDATE_CURRENT_VERSION?.trim();
  if (!version) {
    return null;
  }

  const parsed = updaterSemver.parse(version);
  if (!parsed) {
    console.warn(
      `[updater] Ignoring invalid DREAM_DEV_UPDATE_CURRENT_VERSION: ${version}`,
    );
    return null;
  }

  return parsed;
}

export function initializeAutoUpdater({
  app,
  getMainWindow,
  ipcMain,
  isDevelopment,
}) {
  const devUpdatesEnabled =
    isDevelopment && process.env.DREAM_ENABLE_DEV_UPDATES === "1";
  const devCurrentVersion = devUpdatesEnabled
    ? getDevUpdateCurrentVersion()
    : null;
  const updateFeedUrl = getUpdateFeedUrl();
  const updatesEnabled =
    (app.isPackaged && !isDevelopment) ||
    (devUpdatesEnabled && Boolean(updateFeedUrl));
  let checkInFlight = null;
  let initialUpdateCheckTimer = null;
  let updateCheckTimer = null;
  let status = {
    currentVersion: devCurrentVersion?.format() ?? app.getVersion(),
    enabled: updatesEnabled,
    error: null,
    manual: false,
    progress: null,
    releaseDate: null,
    state: updatesEnabled ? "idle" : "disabled",
    updatedAt: nowIsoString(),
    updateVersion: null,
  };

  const emitStatus = (patch) => {
    status = {
      ...status,
      ...patch,
      updatedAt: nowIsoString(),
    };

    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    mainWindow.webContents.send("updates:status", status);
  };

  const checkForUpdates = async ({ manual = false } = {}) => {
    if (!updatesEnabled) {
      emitStatus({
        error: null,
        manual,
        progress: null,
        state: "disabled",
      });
      return status;
    }

    if (checkInFlight) {
      await checkInFlight;
      return status;
    }

    emitStatus({ error: null, manual, state: "checking" });

    checkInFlight = autoUpdater
      .checkForUpdates()
      .catch((error) => {
        emitStatus({
          error: getErrorMessage(error),
          manual,
          progress: null,
          state: "error",
        });
      })
      .finally(() => {
        checkInFlight = null;
      });

    await checkInFlight;
    return status;
  };

  ipcMain.handle("updates:get-status", () => status);
  ipcMain.handle("updates:check", () => checkForUpdates({ manual: true }));
  ipcMain.handle("updates:install", () => {
    if (status.state !== "downloaded") {
      return false;
    }

    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true);
    });
    return true;
  });

  if (!updatesEnabled) {
    return {
      stop: () => {},
    };
  }

  if (devUpdatesEnabled && !updateFeedUrl) {
    console.warn(
      "[updater] Dev update checks need DREAM_UPDATE_FEED_URL to point at the public R2 releases URL.",
    );
  }

  if (devUpdatesEnabled && updateFeedUrl) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({
      provider: "generic",
      url: updateFeedUrl,
    });
    if (devCurrentVersion) {
      autoUpdater.currentVersion = devCurrentVersion;
      autoUpdater.allowPrerelease =
        updaterSemver.prerelease(devCurrentVersion) !== null;
    }
    console.info(
      `[updater] Dev update checks enabled${
        devCurrentVersion ? ` as version ${devCurrentVersion.format()}` : ""
      }.`,
    );
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    debug: (...args) => console.debug("[updater]", ...args),
    error: (...args) => console.error("[updater]", ...args),
    info: (...args) => console.info("[updater]", ...args),
    warn: (...args) => console.warn("[updater]", ...args),
  };

  autoUpdater.on("update-available", (info) => {
    emitStatus({
      error: null,
      progress: null,
      releaseDate: getUpdateReleaseDate(info),
      state: "available",
      updateVersion: getUpdateVersion(info),
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    emitStatus({
      error: null,
      progress: null,
      releaseDate: getUpdateReleaseDate(info),
      state: "not-available",
      updateVersion: getUpdateVersion(info),
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    emitStatus({
      error: null,
      progress: {
        bytesPerSecond: progress.bytesPerSecond,
        percent: progress.percent,
        total: progress.total,
        transferred: progress.transferred,
      },
      state: "downloading",
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    emitStatus({
      error: null,
      progress: null,
      releaseDate: getUpdateReleaseDate(info),
      state: "downloaded",
      updateVersion: getUpdateVersion(info),
    });
  });

  autoUpdater.on("error", (error) => {
    emitStatus({
      error: getErrorMessage(error),
      progress: null,
      state: "error",
    });
  });

  initialUpdateCheckTimer = setTimeout(() => {
    void checkForUpdates();
  }, INITIAL_UPDATE_CHECK_DELAY_MS);

  updateCheckTimer = setInterval(() => {
    void checkForUpdates();
  }, UPDATE_CHECK_INTERVAL_MS);

  return {
    stop: () => {
      if (initialUpdateCheckTimer !== null) {
        clearTimeout(initialUpdateCheckTimer);
        initialUpdateCheckTimer = null;
      }

      if (updateCheckTimer !== null) {
        clearInterval(updateCheckTimer);
        updateCheckTimer = null;
      }
    },
  };
}
