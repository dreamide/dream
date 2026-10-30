// How the desktop reaches its home host, as the user chose it in Settings >
// Connections, and which host mode a launch ends up in.
//
//   <state database>.desktop-host.json   {"mode", "keepRunning"}
//
// Beside the state database, like its remote-access settings, so a
// development app on its own database (DREAM_DB_PATH) keeps its own.
//
// Host modes:
//   child       the default: the desktop's own host in a child process,
//               attached through the edge listener (desktop-host.js)
//   service     an installed host service that serves this desktop's data
//   remote      no home host; the desktop connects to remote hosts only
//   in-process  the host inside Electron's main process (the escape hatch,
//               and the fallback while the workspace shares the state
//               database's writer)
//
// DREAM_HOST_MODE wins over the preference. `desktop` and `auto` choose as
// if it were unset.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const HOST_MODES = Object.freeze([
  "child",
  "service",
  "remote",
  "in-process",
]);

const ENV_MODES = new Set([...HOST_MODES, "auto", "desktop"]);

export const DEFAULT_DESKTOP_HOST_PREFERENCE = Object.freeze({
  keepRunning: false,
  mode: "local",
});

export const desktopHostPreferencePath = (stateDatabasePath) =>
  `${stateDatabasePath}.desktop-host.json`;

/** The saved preference, or the defaults where it says nothing usable. */
export function readDesktopHostPreference(stateDatabasePath) {
  let saved = {};
  try {
    saved = JSON.parse(
      readFileSync(desktopHostPreferencePath(stateDatabasePath), "utf8"),
    );
  } catch {
    // Missing or unreadable: the defaults.
  }
  return {
    keepRunning: saved?.keepRunning === true,
    mode: saved?.mode === "remote" ? "remote" : "local",
  };
}

/** Saves `changes` over the current preference; returns the result. */
export function writeDesktopHostPreference(stateDatabasePath, changes) {
  const current = readDesktopHostPreference(stateDatabasePath);
  const next = {
    keepRunning:
      typeof changes?.keepRunning === "boolean"
        ? changes.keepRunning
        : current.keepRunning,
    mode:
      changes?.mode === "remote" || changes?.mode === "local"
        ? changes.mode
        : current.mode,
  };
  const target = desktopHostPreferencePath(stateDatabasePath);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  return next;
}

/**
 * The host mode of this launch.
 * @param {{
 *   envMode?: string | null,
 *   preference: { mode: "local" | "remote" },
 *   serviceServesDesktop: () => boolean,
 *   workspaceSeparate: boolean,
 * }} options
 *   `serviceServesDesktop` is asked only when it decides the answer.
 *   `workspaceSeparate`: false while the workspace still lives in the state
 *   database; then only an in-process host can share its one writer.
 * @returns {{ mode: string, reason: string }}
 */
export function resolveDesktopHostMode({
  envMode,
  preference,
  serviceServesDesktop,
  workspaceSeparate,
}) {
  const requested = envMode?.trim() || "";
  if (requested && !ENV_MODES.has(requested)) {
    throw new Error(
      `DREAM_HOST_MODE must be one of ${[...HOST_MODES, "auto"].join(", ")}.`,
    );
  }
  if (requested && requested !== "auto" && requested !== "desktop") {
    return { mode: requested, reason: "DREAM_HOST_MODE" };
  }
  // The workspace still in the state database: its one writer is shared
  // with the host's catalog, which only a host in this process can do.
  if (!workspaceSeparate) {
    return { mode: "in-process", reason: "shared-writer" };
  }
  if (preference.mode === "remote") {
    return { mode: "remote", reason: "preference" };
  }
  if (serviceServesDesktop()) {
    return { mode: "service", reason: "installed-service" };
  }
  return { mode: "child", reason: "default" };
}

/**
 * The host mode as the renderer is told it (`window.dream.hostMode`): it
 * cares only whether the home host is in this process, a separate process
 * that outlives the page, or absent.
 * @param {string} mode
 * @returns {"desktop" | "service" | "remote"}
 */
export const rendererHostMode = (mode) =>
  mode === "remote" ? "remote" : mode === "in-process" ? "desktop" : "service";
