// Where a host daemon says it is running. One private directory per host
// protocol version holds `host.json` (pid, port, token, versions) and the
// daemon's log. A launcher reads it over SSH to reuse a running daemon; the
// token lives only in this owner-only file and on the launcher's stdout,
// never on a command line.
//
//   <home>/run/p<protocol>/host.json   0600
//   <home>/run/p<protocol>/host.log
//   <home>/run/p<protocol>/start.lock  while a launcher is starting one
//   <home>/data/                       the daemon's host data directory
//
// <home> is ~/.dream/host unless DREAM_HOST_HOME says otherwise. Daemons of
// different protocol versions get different run directories, so a new one
// can start while an old one finishes its sessions and idles out.
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const RECORD_FILE = "host.json";
const LOG_FILE = "host.log";
const LOCK_FILE = "start.lock";
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export const getHostHome = (env = process.env) =>
  env.DREAM_HOST_HOME?.trim() || path.join(os.homedir(), ".dream", "host");

export const getRunDirectory = (home, protocolVersion) =>
  path.join(home, "run", `p${protocolVersion}`);

export const getDefaultDataDirectory = (home) => path.join(home, "data");

/** Creates `directory` (and parents) readable by its owner only. */
export function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

/** Writes host.json atomically, owner-only. */
export function writeHostRecord(runDirectory, record) {
  const target = path.join(runDirectory, RECORD_FILE);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

/** The record, or null when there is none or it is unreadable. */
export function readHostRecord(runDirectory) {
  try {
    const record = JSON.parse(
      readFileSync(path.join(runDirectory, RECORD_FILE), "utf8"),
    );
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

/** Removes host.json, but only while it still describes `pid`. */
export function removeHostRecord(runDirectory, pid) {
  if (readHostRecord(runDirectory)?.pid !== pid) return;
  try {
    unlinkSync(path.join(runDirectory, RECORD_FILE));
  } catch {
    // Already gone.
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Takes the start lock so two launchers do not start two daemons. Returns a
 * release function, or null when another launcher holds it. A lock older
 * than `staleMs` (its launcher died) is taken over.
 */
export function acquireStartLock(runDirectory, { staleMs = 60_000 } = {}) {
  const lockPath = path.join(runDirectory, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already released.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs <= staleMs) return null;
        unlinkSync(lockPath);
      } catch {
        // Released between our checks; try again.
      }
    }
  }
  return null;
}

/** Opens the daemon log for appending, rotating it once it grows large. */
export function openHostLog(runDirectory) {
  const logPath = path.join(runDirectory, LOG_FILE);
  try {
    if (existsSync(logPath) && statSync(logPath).size > LOG_ROTATE_BYTES) {
      renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // Keep appending to the current log.
  }
  return openSync(logPath, "a", 0o600);
}
