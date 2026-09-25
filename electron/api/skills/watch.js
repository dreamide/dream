/**
 * Invalidates the skill cache when a skill root changes on disk, so a skill
 * added or edited outside Dream shows up on the next `$` without a restart.
 *
 * Roots are watched once each (bounded), with a short debounce because a
 * single save produces several events. Codex reports its own changes over
 * the app-server (`skills/changed`); this covers the scanned providers.
 */

import { watch } from "node:fs";
import { directoryExists } from "./scan.js";

const MAX_WATCHERS = 64;
const DEBOUNCE_MS = 300;

const watchers = new Map();
let onChange = () => {};
let debounceTimer = null;

export const setSkillWatchHandler = (handler) => {
  onChange = typeof handler === "function" ? handler : () => {};
};

const scheduleChange = () => {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    onChange();
  }, DEBOUNCE_MS);
};

/**
 * Starts watching `directories` that exist and are not already watched.
 * Recursive watching is native on Windows and macOS; on Linux only the root
 * itself is watched, which still catches new or removed skill folders.
 */
export const watchSkillRoots = async (directories) => {
  for (const directory of directories) {
    if (
      !directory ||
      watchers.has(directory) ||
      watchers.size >= MAX_WATCHERS
    ) {
      continue;
    }
    if (!(await directoryExists(directory))) {
      continue;
    }
    try {
      const watcher = watch(
        directory,
        { persistent: false, recursive: process.platform !== "linux" },
        scheduleChange,
      );
      watcher.on("error", () => {
        watcher.close();
        watchers.delete(directory);
      });
      watchers.set(directory, watcher);
    } catch {
      // Watching is best effort; the cache TTL still refreshes the list.
    }
  }
};

export const stopSkillWatchers = () => {
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  watchers.clear();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
};
