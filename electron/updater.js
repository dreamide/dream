import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

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

export function initializeAutoUpdater({
  app,
  getMainWindow,
  ipcMain,
  isDevelopment,
}) {
  const updatesEnabled = app.isPackaged && !isDevelopment;
  let checkInFlight = null;
  let initialUpdateCheckTimer = null;
  let updateCheckTimer = null;
  let status = {
    currentVersion: app.getVersion(),
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

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
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
