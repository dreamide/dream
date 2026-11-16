// Chat folders: the folders of standalone chats (GLOSSARY.md, Standalone
// chat). Each standalone chat's Project gets one folder of its own under
// `~/.dream/chats` on its Host, created with the Project, so agents, terminals
// and checkpoints work in it like any Project folder.
//
// The root must not be inside a git checkout: agents would read that
// repository's instructions and git would report its status, so creating a
// chat folder there is refused.
import { lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGitCommand } from "../api/project-git/core.js";
import { normalizeProjectPathKey } from "../shared/persisted-state-codec.js";

/** How many characters of the Project id name its chat folder. */
const PROJECT_ID_PREFIX_LENGTH = 8;

/** The folder that holds every chat folder on this host. */
export const getChatFoldersRoot = (home = os.homedir()) =>
  path.join(home, ".dream", "chats");

const pad = (value) => String(value).padStart(2, "0");

/**
 * A chat folder's name: the host's local date and the start of the Project
 * id, e.g. `2026-11-16-1a2b3c4d`.
 * @param {string} projectId
 * @param {Date} date
 */
export const getChatFolderName = (projectId, date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${projectId.slice(0, PROJECT_ID_PREFIX_LENGTH)}`;

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
 *   findGitTopLevel?: (folder: string) => Promise<string | null>,
 * }} options
 */
export async function createChatFolder({
  projectId,
  home = os.homedir(),
  now = new Date(),
  findGitTopLevel = defaultFindGitTopLevel,
}) {
  const root = getChatFoldersRoot(home);
  await assertOutsideGit(root, findGitTopLevel);
  await mkdir(root, { recursive: true });
  const folder = path.join(root, getChatFolderName(projectId, now));
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

/** A folder this young may not have reached the catalog yet. */
export const CHAT_FOLDER_SWEEP_GRACE_MS = 60 * 60 * 1000;

/** What a folder may hold and still be removed: nothing an agent made. */
const DISPOSABLE_ENTRIES = new Set(["node_modules"]);

/**
 * Removes chat folders no Project owns any more and that hold nothing worth
 * keeping (empty, or only `node_modules`). A folder with anything else in
 * it is the user's and stays. Folders younger than the grace period are
 * skipped, since a new chat's folder exists before its Project reaches the
 * catalog. Only real folders directly under the root are considered;
 * symlinks are never followed.
 * @param {{ list: () => Promise<{ projects: unknown[] }> }} catalog
 * @param {{ home?: string, now?: number, graceMs?: number }} [options]
 * @returns {Promise<string[]>} the folders removed
 */
export async function sweepChatFolders(
  catalog,
  {
    home = os.homedir(),
    now = Date.now(),
    graceMs = CHAT_FOLDER_SWEEP_GRACE_MS,
  } = {},
) {
  const root = getChatFoldersRoot(home);
  const removed = [];
  try {
    const entries = await readdir(root, { withFileTypes: true }).catch(
      (error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      },
    );
    const folders = entries.filter((entry) => entry.isDirectory());
    if (folders.length === 0) return removed;

    const { projects } = await catalog.list();
    const owned = new Set(
      projects.map((project) =>
        normalizeProjectPathKey(
          typeof project?.path === "string" ? project.path : "",
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
