// `POST /api/host-directories`: the folders in one folder of this host, for
// picking a project folder on a machine whose disk the window cannot see
// (Open on SSH Host). Starts at the home folder of the user the host runs
// as. Folders only; files are not a project.
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { handleJsonRoute, RouteError } from "./shared/json-route.js";

/** Folders listed at most per folder; a bigger one says it was cut short. */
export const HOST_DIRECTORY_LIMIT = 2000;

export const hostDirectoriesRequestSchema = z.object({
  /** A folder on the host: absolute, `~`, `~/...`, or relative to home. */
  path: z.string().optional(),
});

/**
 * `requested` as an absolute folder on this host: home when empty, `~`
 * expanded, relative to home otherwise.
 * @param {string | undefined} requested
 * @param {string} home
 */
export const resolveHostDirectory = (requested, home) => {
  const value = requested?.trim() ?? "";
  if (!value || value === "~") return home;
  if (value.startsWith("~/")) return path.resolve(home, value.slice(2));
  return path.resolve(home, value);
};

/** @param {NodeJS.ErrnoException} error */
const asRouteError = (error, folder) => {
  switch (error?.code) {
    case "ENOENT":
      return new RouteError(`No folder at ${folder}.`, 404);
    case "ENOTDIR":
      return new RouteError(`${folder} is not a folder.`, 400);
    case "EACCES":
    case "EPERM":
      return new RouteError(`No permission to open ${folder}.`, 403);
    default:
      return error;
  }
};

/**
 * The folders in `requested` (see resolveHostDirectory), sorted by name.
 * A symlink counts when it points at a folder.
 * @param {string | undefined} requested
 * @param {{ home?: string }} [options]
 */
export async function listHostDirectories(
  requested,
  { home = os.homedir() } = {},
) {
  const folder = resolveHostDirectory(requested, home);
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch (error) {
    throw asRouteError(error, folder);
  }

  const names = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(entry.name);
    } else if (entry.isSymbolicLink()) {
      try {
        if ((await stat(path.join(folder, entry.name))).isDirectory()) {
          names.push(entry.name);
        }
      } catch {
        // A dangling link is not a folder.
      }
    }
  }
  names.sort((a, b) => a.localeCompare(b));

  const parent = path.dirname(folder);
  return {
    directories: names.slice(0, HOST_DIRECTORY_LIMIT).map((name) => ({
      hidden: name.startsWith("."),
      name,
      path: path.join(folder, name),
    })),
    home,
    parent: parent === folder ? null : parent,
    path: folder,
    separator: path.sep,
    truncated: names.length > HOST_DIRECTORY_LIMIT,
  };
}

/**
 * @param {import("hono").Hono} app
 * @param {{ home?: string }} [options]
 */
export function registerHostDirectoryRoutes(app, options = {}) {
  app.post("/api/host-directories", (c) =>
    handleJsonRoute(
      c,
      hostDirectoriesRequestSchema,
      ({ path: requested }) => listHostDirectories(requested, options),
      { errorMessage: "Unable to list folders.", missingBody: {} },
    ),
  );
}
