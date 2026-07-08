import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import electronUpdater from "electron-updater";

const require = createRequire(import.meta.url);
const updaterRequire = createRequire(require.resolve("electron-updater"));
const updaterSemver = updaterRequire("semver");

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const INITIAL_UPDATE_CHECK_DELAY_MS = 5000;
const ANONYMOUS_STAGING_USER_ID = "00000000-0000-4000-8000-000000000000";

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

function parseScalar(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function getPackagedUpdateFeedUrl() {
  if (!process.resourcesPath) {
    return null;
  }

  try {
    const config = readFileSync(
      path.join(process.resourcesPath, "app-update.yml"),
      "utf8",
    );
    const match = config.match(/^\s*url:\s*(.+?)\s*$/m);
    const url = match ? parseScalar(match[1]).trim() : null;

    return url ? url.replace(/\/+$/, "") : null;
  } catch {
    return null;
  }
}

function getBaseUpdateFeedUrl() {
  return getUpdateFeedUrl() ?? getPackagedUpdateFeedUrl();
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

function applyDevUpdateCurrentVersion(app, devCurrentVersion) {
  if (!devCurrentVersion || typeof app.setVersion !== "function") {
    return;
  }

  app.setVersion(devCurrentVersion.format());
}

function writeDevUpdateConfig(app, updateFeedUrl) {
  const configDir = path.join(app.getPath("userData"), "updater-dev");
  const configPath = path.join(configDir, "dev-app-update.yml");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    configPath,
    `provider: generic
url: ${JSON.stringify(updateFeedUrl)}
updaterCacheDirName: dream-updater
`,
    "utf8",
  );

  return configPath;
}

function getUpdateChannel(version) {
  const parsed = updaterSemver.parse(version);
  const prerelease = parsed ? updaterSemver.prerelease(parsed) : null;
  if (!prerelease?.length) {
    return "stable";
  }

  return String(prerelease[0] ?? "prerelease");
}

function getUpdateTelemetryPayload({ currentVersion, manual }) {
  const version = String(currentVersion || "unknown");

  return {
    arch: process.arch,
    channel: getUpdateChannel(version),
    check: manual ? "manual" : "automatic",
    platform: process.platform,
    version,
  };
}

function addInstallIdToPayload(payload, installId) {
  if (typeof installId !== "string" || !installId.trim()) {
    return payload;
  }

  return {
    ...payload,
    installId: installId.trim(),
  };
}

function sanitizeHeaderValue(value) {
  return String(value)
    .replace(/[\r\n]/g, "")
    .replace(/[^\t\x20-\x7e]/g, "");
}

function getUpdateTelemetryHeaders(payload) {
  const headers = {
    "X-Dream-Arch": sanitizeHeaderValue(payload.arch),
    "X-Dream-Channel": sanitizeHeaderValue(payload.channel),
    "X-Dream-Platform": sanitizeHeaderValue(payload.platform),
    "X-Dream-Update-Check": sanitizeHeaderValue(payload.check),
    "X-Dream-Version": sanitizeHeaderValue(payload.version),
  };

  if (payload.installId) {
    headers["X-Dream-Install-Id"] = sanitizeHeaderValue(payload.installId);
  }

  return headers;
}

function getTelemetryUpdateFeedUrl(updateFeedUrl, payload) {
  if (!updateFeedUrl) {
    return null;
  }

  try {
    const url = new URL(updateFeedUrl);
    for (const [key, value] of Object.entries(payload)) {
      url.searchParams.set(key, value);
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function configureUpdateTelemetry(autoUpdater, updateFeedUrl, payload) {
  const requestHeaders = getUpdateTelemetryHeaders(payload);
  const telemetryUpdateFeedUrl = getTelemetryUpdateFeedUrl(
    updateFeedUrl,
    payload,
  );

  if (telemetryUpdateFeedUrl) {
    autoUpdater.setFeedURL({
      provider: "generic",
      requestHeaders,
      url: telemetryUpdateFeedUrl,
    });
    return;
  }

  autoUpdater.requestHeaders = requestHeaders;
}

function removeHeader(headers, headerName) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === headerName) {
      delete headers[key];
    }
  }
}

function disableUpdateStagingIdentifier(autoUpdater) {
  autoUpdater.stagingUserIdPromise = {
    get value() {
      return Promise.resolve(ANONYMOUS_STAGING_USER_ID);
    },
  };
  autoUpdater.isUserWithinRollout = () => true;

  const computeFinalHeaders =
    autoUpdater.computeFinalHeaders?.bind(autoUpdater);
  if (typeof computeFinalHeaders !== "function") {
    return;
  }

  autoUpdater.computeFinalHeaders = (headers = {}) => {
    const finalHeaders = computeFinalHeaders(headers);
    removeHeader(finalHeaders, "x-user-staging-id");
    return finalHeaders;
  };
}

export function initializeAutoUpdater({
  app,
  getMainWindow,
  installId,
  ipcMain,
  isDevelopment,
}) {
  const devUpdatesEnabled =
    isDevelopment && process.env.DREAM_ENABLE_DEV_UPDATES === "1";
  const devCurrentVersion = devUpdatesEnabled
    ? getDevUpdateCurrentVersion()
    : null;
  const updateFeedUrl = getBaseUpdateFeedUrl();
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
    showDetailedStatus: devUpdatesEnabled,
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
    configureUpdateTelemetry(
      autoUpdater,
      updateFeedUrl,
      addInstallIdToPayload(
        getUpdateTelemetryPayload({
          currentVersion: status.currentVersion,
          manual,
        }),
        installId,
      ),
    );

    checkInFlight = autoUpdater
      .checkForUpdates()
      .then(async (result) => {
        await result?.downloadPromise?.catch((error) => {
          emitStatus({
            error: getErrorMessage(error),
            manual,
            progress: null,
            state: "error",
          });
        });
      })
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
    applyDevUpdateCurrentVersion(app, devCurrentVersion);
  }

  const { autoUpdater } = electronUpdater;
  disableUpdateStagingIdentifier(autoUpdater);

  if (devUpdatesEnabled && updateFeedUrl) {
    autoUpdater.updateConfigPath = writeDevUpdateConfig(app, updateFeedUrl);
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
  autoUpdater.disableWebInstaller = true;
  autoUpdater.disableDifferentialDownload = true;
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
