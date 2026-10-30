// Whether this desktop runs agents on this computer (Settings > Hosts >
// This app), and which host mode a launch ends up in.
//
//   <state database>.desktop-host.json   {"mode": "local" | "remote"}
//
// Beside the state database, like its remote-access settings, so a
// development app on its own database (DREAM_DB_PATH) keeps its own.
//
// Host modes:
//   detached    the default: the host running on this desktop's database,
//               whoever started it, or one the desktop starts and stops
//               (desktop-host.js)
//   remote      no host on this computer; the desktop uses remote hosts
//   in-process  the host inside Electron's main process (the escape hatch,
//               and the only choice while the workspace shares the state
//               database's writer)
//
// DREAM_HOST_MODE (`auto`, `remote` or `in-process`) wins over the
// preference; `auto` and `desktop` choose as if it were unset.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const ENV_MODES = new Set(["auto", "desktop", "remote", "in-process"]);

export const DEFAULT_DESKTOP_HOST_PREFERENCE = Object.freeze({
  mode: "local",
});

export const desktopHostPreferencePath = (stateDatabasePath) =>
  `${stateDatabasePath}.desktop-host.json`;

/** The saved preference, or the default where it says nothing usable. */
export function readDesktopHostPreference(stateDatabasePath) {
  let saved = {};
  try {
    saved = JSON.parse(
      readFileSync(desktopHostPreferencePath(stateDatabasePath), "utf8"),
    );
  } catch {
    // Missing or unreadable: the default.
  }
  return { mode: saved?.mode === "remote" ? "remote" : "local" };
}

/** Saves `changes` over the current preference; returns the result. */
export function writeDesktopHostPreference(stateDatabasePath, changes) {
  const current = readDesktopHostPreference(stateDatabasePath);
  const next = {
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
 *   workspaceSeparate: boolean,
 * }} options
 *   `workspaceSeparate`: false while the workspace still lives in the state
 *   database; then only an in-process host can share its one writer.
 * @returns {{ mode: "detached" | "remote" | "in-process", reason: string }}
 */
export function resolveDesktopHostMode({
  envMode,
  preference,
  workspaceSeparate,
}) {
  const requested = envMode?.trim() || "";
  if (requested === "service") {
    throw new Error(
      "DREAM_HOST_MODE=service was removed: run `dream-host serve` on this desktop's data and the desktop attaches to it.",
    );
  }
  if (requested && !ENV_MODES.has(requested)) {
    throw new Error("DREAM_HOST_MODE must be auto, remote or in-process.");
  }
  if (requested === "remote" || requested === "in-process") {
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
  return { mode: "detached", reason: "default" };
}
