// Where a host keeps its own files (the state database, checkpoints, legacy
// worktrees). The local host is told its directory by the Electron main
// process (the app's userData folder); a host daemon will be told by its
// command line. Nothing in the host asks Electron for a path.
import path from "node:path";

let hostDataDirectory = null;

/** @param {string} directory */
export function configureHostDataDirectory(directory) {
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("Host data directory must be a non-empty path.");
  }
  hostDataDirectory = path.resolve(directory);
}

/** The configured directory, or null before the host is configured. */
export function getHostDataDirectory() {
  return hostDataDirectory;
}

/** The configured directory; throws before the host is configured. */
export function requireHostDataDirectory() {
  if (!hostDataDirectory) {
    throw new Error("Host data directory is not configured.");
  }
  return hostDataDirectory;
}
