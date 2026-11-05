// One host per state database. A host's catalog has exactly one writer, so
// two host processes on one database (the desktop's child and a service's,
// or two launchers' daemons) must not both run: the second refuses to start
// and says which process has it.
//
//   <state database>.host-owner  an SQLite file this host holds an exclusive
//                                transaction on for its whole life. The
//                                operating system drops it when the process
//                                ends, however it ends, so a crash leaves
//                                nothing to clean up and a reused PID
//                                proves nothing.
//   <state database>.host-lock   {"pid", "startedAt", "kind", "lock": "os"}:
//                                who holds it, for messages and for the
//                                desktop checking it attached to the owner.
//                                Written once the lock is held; a record
//                                whose lock is free describes nobody.
//
// A record without `lock: "os"` was written by a host from before this
// lock existed, which only knows the record: while its PID lives it is
// treated as held, so old and new hosts still exclude each other.
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export class StateLockedError extends Error {
  /** @param {{ pid: number, startedAt?: string, kind?: string }} holder */
  constructor(lockPath, holder) {
    const who = holder
      ? `${holder.kind ?? "process"} ${holder.pid}, since ${holder.startedAt ?? "unknown"}`
      : "another process";
    super(
      `Another Dream host (${who}) is using this host's data. Stop it, or connect to it instead of starting a second one.`,
    );
    this.name = "StateLockedError";
    this.lockPath = lockPath;
    this.holder = holder;
  }
}

export const stateLockPaths = (stateDatabasePath) => ({
  owner: `${stateDatabasePath}.host-owner`,
  record: `${stateDatabasePath}.host-lock`,
});

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return error?.code === "EPERM";
  }
};

/** The holder record, or null when there is none or it is unreadable. */
export function readStateLockRecord(stateDatabasePath) {
  try {
    const holder = JSON.parse(
      readFileSync(stateLockPaths(stateDatabasePath).record, "utf8"),
    );
    return Number.isInteger(holder?.pid) ? holder : null;
  } catch {
    return null;
  }
}

const isBusy = (error) =>
  error?.errcode === 5 ||
  error?.errcode === 6 ||
  /database is locked|database table is locked|SQLITE_BUSY/i.test(
    String(error?.message ?? ""),
  );

/**
 * Opens the owner file and takes its exclusive transaction: the open
 * connection while held, null while another connection (in this process or
 * any other) holds it.
 */
function holdOwner(ownerPath, busyTimeoutMs) {
  const database = new DatabaseSync(ownerPath);
  try {
    database.exec(`PRAGMA busy_timeout = ${Math.max(0, busyTimeoutMs)}`);
    // Never WAL: its readers coexist with a writer, and the point is
    // that nobody else gets in.
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec("BEGIN EXCLUSIVE");
    return database;
  } catch (error) {
    database.close();
    if (isBusy(error)) return null;
    throw error;
  }
}

const release = (database) => {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Nothing was written; closing ends the transaction anyway.
  }
  database.close();
};

/** Whether a host from before the OS lock still holds this database. */
const heldByOlderHost = (holder, pid, alive) =>
  holder !== null &&
  holder.lock !== "os" &&
  holder.pid !== pid &&
  alive(holder.pid);

/**
 * Whether a live host holds the lock on `stateDatabasePath` now (this
 * process included). For checks such as "has the previous host exited".
 * @param {string} stateDatabasePath
 * @param {{ alive?: (pid: number) => boolean }} [options]
 */
export function isStateLockHeld(stateDatabasePath, { alive = isAlive } = {}) {
  const holder = readStateLockRecord(stateDatabasePath);
  if (heldByOlderHost(holder, -1, alive)) return true;
  const database = holdOwner(stateLockPaths(stateDatabasePath).owner, 0);
  if (!database) return true;
  release(database);
  return false;
}

/**
 * Takes the lock on `stateDatabasePath` for this process; returns its
 * release. Throws StateLockedError while another live host holds it.
 * @param {string} stateDatabasePath
 * @param {{
 *   kind?: string,
 *   pid?: number,
 *   now?: () => string,
 *   alive?: (pid: number) => boolean,
 *   busyTimeoutMs?: number,
 *   details?: Record<string, unknown>,
 * }} [options]
 *   `busyTimeoutMs`: how long to wait out a momentary holder (a probe by
 *   `isStateLockHeld`) before giving up. `details`: more for the record
 *   (a daemon's run directory and owner, so the host can be found from
 *   its database).
 */
export function acquireStateLock(
  stateDatabasePath,
  {
    kind = "host",
    pid = process.pid,
    now = () => new Date().toISOString(),
    alive = isAlive,
    busyTimeoutMs = 1_000,
    details = {},
  } = {},
) {
  const paths = stateLockPaths(stateDatabasePath);
  const previous = readStateLockRecord(stateDatabasePath);
  if (heldByOlderHost(previous, pid, alive)) {
    throw new StateLockedError(paths.record, previous);
  }
  const database = holdOwner(paths.owner, busyTimeoutMs);
  if (!database) {
    throw new StateLockedError(
      paths.record,
      readStateLockRecord(stateDatabasePath),
    );
  }

  // Held: whatever record is there describes a host that has gone.
  const record = { ...details, kind, lock: "os", pid, startedAt: now() };
  try {
    const temporary = `${paths.record}.${pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, paths.record);
  } catch (error) {
    release(database);
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only our own record: never one a later host wrote.
    const current = readStateLockRecord(stateDatabasePath);
    if (current?.pid === pid && current.startedAt === record.startedAt) {
      rmSync(paths.record, { force: true });
    }
    release(database);
  };
}
