// The desktop's own workspace database, apart from its local host's.
//
// A host's state database (dream.db) holds its catalog: projects, chats,
// transcripts, run queues, provider and device sessions. The desktop's
// workspace (its config and settings, saved prompts, which projects are
// open where and their layout) is this client's, not the host's, and lives
// beside it in `<name>.workspace.db`. Each file has exactly one writer: the
// host's save queue for the catalog, the desktop's for its workspace, so a
// host can run in a process of its own (`dream-host`) without two processes
// writing one file.
//
// Both use the one schema and its migrations; each uses only its own
// tables: the workspace's `config`, `saved_prompts` and `workspace_projects`,
// the host's everything else.
//
// Moving an existing workspace out of the state database happens once, at
// startup, before either writer opens a file, and never changes the state
// database:
//   1. a consistent copy of the state database (VACUUM INTO) is kept under
//      `backups/`, and brought to the current schema;
//   2. the workspace tables are copied from that copy into
//      `<name>.workspace.db.partial`;
//   3. the partial file is renamed into place.
// An interruption before the rename leaves only a partial file, which the
// next start discards and does again; after it, the move is done. The
// workspace tables left in the state database are no longer read or written.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  closePersistedStateDatabase,
  getPersistedStateDatabase,
} from "./persisted-state.js";

/** The tables that are the client's workspace, not the host's catalog. */
export const WORKSPACE_TABLES = Object.freeze([
  "config",
  "saved_prompts",
  "workspace_projects",
]);

const MIGRATED_FROM_KEY = "workspaceDatabase.migratedFrom";

/** The workspace database beside the state database `stateDatabasePath`. */
export const resolveWorkspaceDatabasePath = (stateDatabasePath) => {
  const parsed = path.parse(stateDatabasePath);
  const base = parsed.ext === ".db" ? parsed.name : parsed.base;
  return path.join(parsed.dir, `${base}.workspace.db`);
};

const sidecars = (file) => [
  file,
  `${file}-wal`,
  `${file}-shm`,
  `${file}-journal`,
];

const removeWithSidecars = (file) => {
  for (const candidate of sidecars(file)) rmSync(candidate, { force: true });
};

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * Makes sure the workspace database exists, moving the workspace out of the
 * state database the first time. Synchronous: it runs once, at startup,
 * before the save queues start.
 * @param {{ stateDatabasePath: string, now?: () => Date }} options
 * @returns {{ workspaceDatabasePath: string, migrated: boolean, backupPath: string | null }}
 */
export function prepareWorkspaceDatabase({
  stateDatabasePath,
  now = () => new Date(),
}) {
  const workspaceDatabasePath = resolveWorkspaceDatabasePath(stateDatabasePath);
  const partialPath = `${workspaceDatabasePath}.partial`;

  // Done before (the rename is the last step).
  if (existsSync(workspaceDatabasePath)) {
    removeWithSidecars(partialPath);
    return { backupPath: null, migrated: false, workspaceDatabasePath };
  }
  // A move that did not finish: start it over.
  removeWithSidecars(partialPath);
  // Nothing to move: a new install starts with an empty workspace.
  if (!existsSync(stateDatabasePath)) {
    return { backupPath: null, migrated: false, workspaceDatabasePath };
  }

  const at = now();
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const backupDirectory = path.join(path.dirname(stateDatabasePath), "backups");
  mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(
    backupDirectory,
    `${path.parse(stateDatabasePath).name}-before-workspace-split-${stamp}.db`,
  );

  // 1. A consistent copy, the WAL included, without writing the original.
  removeWithSidecars(backupPath);
  const source = new DatabaseSync(stateDatabasePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO ${quote(backupPath)}`);
  } finally {
    source.close();
  }
  // Brought to the current schema, so its tables match the workspace's.
  // (Migrating the copy leaves the original as it was.)
  // One self-contained file: no WAL sidecar to lose when it is copied, and
  // none a read-only reader would need.
  getPersistedStateDatabase({ databasePath: backupPath }).exec(
    "PRAGMA journal_mode = DELETE",
  );
  closePersistedStateDatabase();

  // 2. The workspace tables, from the copy into a partial file.
  const workspace = getPersistedStateDatabase({ databasePath: partialPath });
  try {
    workspace.exec(`ATTACH DATABASE ${quote(backupPath)} AS source`);
    workspace.exec("BEGIN");
    try {
      for (const table of WORKSPACE_TABLES) {
        workspace.exec(`DELETE FROM main.${table}`);
        workspace.exec(
          `INSERT INTO main.${table} SELECT * FROM source.${table}`,
        );
      }
      workspace
        .prepare(
          "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .run(
          MIGRATED_FROM_KEY,
          JSON.stringify({
            at: at.toISOString(),
            backup: backupPath,
            from: path.basename(stateDatabasePath),
          }),
          at.toISOString(),
        );
      workspace.exec("COMMIT");
    } catch (error) {
      workspace.exec("ROLLBACK");
      throw error;
    }
    workspace.exec("DETACH DATABASE source");
    // One file to rename: everything checkpointed into it.
    workspace.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    workspace.exec("PRAGMA journal_mode = DELETE");
  } finally {
    closePersistedStateDatabase();
  }

  // 3. In place: from here on, the move is done.
  renameSync(partialPath, workspaceDatabasePath);
  return { backupPath, migrated: true, workspaceDatabasePath };
}
