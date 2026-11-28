// Chat folders: the folders of standalone chats (GLOSSARY.md, Standalone
// chat). Each standalone chat's Project gets one folder of its own under
// `~/.dream/chats` on its Host, created with the Project, so agents, terminals
// and checkpoints work in it like any Project folder.
//
// Every host on a machine shares that root, but each has its own state
// database, so a folder's name ends with its database's owner tag: a host
// sweeps only folders it made, never another database's (the installed app
// beside a dev build, or a test host).
//
// The root must not be inside a git checkout: agents would read that
// repository's instructions and git would report its status, so creating a
// chat folder there is refused.
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGitCommand } from "../api/project-git/core.js";
import { normalizeProjectPathKey } from "../shared/persisted-state-codec.js";

/** How many characters of the Project id name its chat folder. */
const PROJECT_ID_PREFIX_LENGTH = 8;

/** How many hex characters of the database path's hash tag a folder. */
const OWNER_TAG_LENGTH = 8;

/**
 * The tag naming which state database made a chat folder.
 * @param {string} databasePath
 */
export const getChatFolderOwner = (databasePath) =>
  createHash("sha256")
    .update(normalizeProjectPathKey(path.resolve(databasePath)))
    .digest("hex")
    .slice(0, OWNER_TAG_LENGTH);

/** This host's owner tag, or null when no host is configured. */
const defaultOwner = async () => {
  try {
    const { resolveStateDatabasePath } = await import("../persisted-state.js");
    return getChatFolderOwner(resolveStateDatabasePath());
  } catch {
    return null;
  }
};

/** The folder that holds every chat folder on this host. */
export const getChatFoldersRoot = (home = os.homedir()) =>
  path.join(home, ".dream", "chats");

const pad = (value) => String(value).padStart(2, "0");

/**
 * A chat folder's name: the host's local date, the start of the Project id
 * and the owner tag, e.g. `2026-11-16-1a2b3c4d-9f8e7d6c`.
 * @param {string} projectId
 * @param {Date} date
 * @param {string} owner
 */
export const getChatFolderName = (projectId, date, owner) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${projectId.slice(0, PROJECT_ID_PREFIX_LENGTH)}-${owner}`;

/** Why a chat folder cannot be created; `reason` is shown to the user. */
export class ChatFolderError extends Error {
  /**
   * @param {"inside-git" | "exists"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = "ChatFolderError";
    this.code = code;
  }
}

const exists = async (folder) => {
  try {
    await stat(folder);
    return true;
  } catch {
    return false;
  }
};

/** The closest folder at or above `folder` that exists. */
const nearestExistingFolder = async (folder) => {
  let current = folder;
  while (!(await exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
};

/**
 * The top level of the git work tree `folder` is inside, or null. A missing
 * git counts as no work tree.
 * @param {string} folder
 */
const defaultFindGitTopLevel = async (folder) => {
  const result = await runGitCommand(folder, ["rev-parse", "--show-toplevel"], {
    allowFailure: true,
  });
  const topLevel = result.ok ? result.stdout.trim() : "";
  return topLevel || null;
};

/**
 * Refuses when the chat folder root is inside a git work tree.
 * @param {string} root
 * @param {(folder: string) => Promise<string | null>} findGitTopLevel
 */
const assertOutsideGit = async (root, findGitTopLevel) => {
  const existing = await nearestExistingFolder(root);
  if (!existing) return;
  const topLevel = await findGitTopLevel(existing);
  if (topLevel) {
    throw new ChatFolderError(
      "inside-git",
      `Chats are unavailable because ${root} is inside the Git repository at ${path.normalize(topLevel)}.`,
    );
  }
};

/**
 * Creates the chat folder of a new standalone project and returns its path.
 * The leaf is created non-recursively, so a folder that already exists is
 * never handed out twice.
 * @param {{
 *   projectId: string,
 *   home?: string,
 *   now?: Date,
 *   owner?: string | null,
 *   findGitTopLevel?: (folder: string) => Promise<string | null>,
 * }} options
 *   `owner`: this host's tag (getChatFolderOwner); its database's by default.
 */
export async function createChatFolder({
  projectId,
  home = os.homedir(),
  now = new Date(),
  owner,
  findGitTopLevel = defaultFindGitTopLevel,
}) {
  const tag = owner ?? (await defaultOwner());
  if (!tag) throw new Error("No host is configured to own a chat folder.");
  const root = getChatFoldersRoot(home);
  await assertOutsideGit(root, findGitTopLevel);
  await mkdir(root, { recursive: true });
  const folder = path.join(root, getChatFolderName(projectId, now, tag));
  try {
    await mkdir(folder);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new ChatFolderError("exists", `${folder} already exists.`);
    }
    throw error;
  }
  return { path: folder };
}

/**
 * Recreates a chat folder that has gone missing (a sweep, or the user, may
 * have removed it while empty), so its chats can run again. Only a folder
 * directly under the root is recreated: any other path is a folder the user
 * picked and is never made. True when it was recreated.
 * @param {string} projectPath
 * @param {{ home?: string }} [options]
 */
export async function restoreChatFolder(
  projectPath,
  { home = os.homedir() } = {},
) {
  if (typeof projectPath !== "string" || !projectPath.trim()) return false;
  const root = getChatFoldersRoot(home);
  const folder = path.resolve(projectPath);
  if (
    normalizeProjectPathKey(path.dirname(folder)) !==
    normalizeProjectPathKey(root)
  ) {
    return false;
  }
  if (await exists(folder)) return false;
  await mkdir(root, { recursive: true });
  try {
    await mkdir(folder);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  return true;
}

/** A folder this young may not have reached the catalog yet. */
export const CHAT_FOLDER_SWEEP_GRACE_MS = 60 * 60 * 1000;

/** What a folder may hold and still be removed: nothing an agent made. */
const DISPOSABLE_ENTRIES = new Set(["node_modules"]);

/**
 * Removes this host's chat folders no Project owns any more and that hold
 * nothing worth keeping (empty, or only `node_modules`). Only folders named
 * with this host's owner tag are considered: the catalog speaks for its own
 * database, so another database's folders (and older untagged ones) are
 * never touched. A folder with anything else in it is the user's and stays.
 * Folders younger than the grace period are skipped, since a new chat's
 * folder exists before its Project reaches the catalog. Only real folders
 * directly under the root are considered; symlinks are never followed.
 * @param {{ list: () => Promise<{ projects: unknown[] }> }} catalog
 * @param {{ home?: string, now?: number, graceMs?: number, owner?: string | null }} [options]
 *   `owner`: this host's tag (getChatFolderOwner); its database's by default.
 * @returns {Promise<string[]>} the folders removed
 */
export async function sweepChatFolders(
  catalog,
  {
    home = os.homedir(),
    now = Date.now(),
    graceMs = CHAT_FOLDER_SWEEP_GRACE_MS,
    owner,
  } = {},
) {
  const root = getChatFoldersRoot(home);
  const removed = [];
  try {
    const tag = owner ?? (await defaultOwner());
    if (!tag) return removed;
    const entries = await readdir(root, { withFileTypes: true }).catch(
      (error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      },
    );
    const folders = entries.filter(
      (entry) => entry.isDirectory() && entry.name.endsWith(`-${tag}`),
    );
    if (folders.length === 0) return removed;

    const projectPaths = catalog.listProjectPaths
      ? await catalog.listProjectPaths()
      : (await catalog.list()).projects.map((project) =>
          typeof project?.path === "string" ? project.path : "",
        );
    const owned = new Set(
      projectPaths.map((projectPath) =>
        normalizeProjectPathKey(
          typeof projectPath === "string" ? projectPath : "",
        ),
      ),
    );
    for (const entry of folders) {
      const folder = path.join(root, entry.name);
      if (owned.has(normalizeProjectPathKey(folder))) continue;
      const stats = await lstat(folder);
      if (!stats.isDirectory() || now - stats.mtimeMs < graceMs) continue;
      const contents = await readdir(folder);
      if (!contents.every((name) => DISPOSABLE_ENTRIES.has(name))) continue;
      await rm(folder, { force: true, recursive: true });
      removed.push(folder);
    }
  } catch (error) {
    console.warn("Unable to clean up chat folders.", error);
  }
  return removed;
}
