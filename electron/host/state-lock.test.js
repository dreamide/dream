import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireStateLock,
  isStateLockHeld,
  readStateLockRecord,
  StateLockedError,
  stateLockPaths,
} from "./state-lock.js";

let directory;
let database;

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "dream-state-lock-"));
  database = path.join(directory, "dream.db");
});

afterEach(() => {
  rmSync(directory, { force: true, recursive: true });
});

const writeRecord = (record) =>
  writeFileSync(stateLockPaths(database).record, JSON.stringify(record));

/** A separate Node process holding the lock until it is killed. */
const holdInChild = () =>
  new Promise((resolve, reject) => {
    const module = pathToFileURL(
      path.join(import.meta.dirname, "state-lock.js"),
    ).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { acquireStateLock } from ${JSON.stringify(module)};
         acquireStateLock(${JSON.stringify(database)}, { kind: "child" });
         process.stdout.write("held\\n");
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`child exited ${code}`)));
    child.stdout.on("data", (data) => {
      if (String(data).includes("held")) resolve(child);
    });
  });

const killed = (child) =>
  new Promise((resolve) => {
    child.removeAllListeners("exit");
    child.once("exit", resolve);
    child.kill("SIGKILL");
  });

describe("acquireStateLock", () => {
  it("refuses a second holder in the same process and names the first", () => {
    const release = acquireStateLock(database, { kind: "desktop" });
    expect(() =>
      acquireStateLock(database, { busyTimeoutMs: 0, kind: "daemon" }),
    ).toThrow(StateLockedError);
    try {
      acquireStateLock(database, { busyTimeoutMs: 0 });
    } catch (error) {
      expect(error.holder).toMatchObject({
        kind: "desktop",
        lock: "os",
        pid: process.pid,
      });
    }
    release();
    expect(readStateLockRecord(database)).toBeNull();
    acquireStateLock(database)();
  });

  it("is not blocked by a record whose lock nobody holds", () => {
    // A crashed host's record, its PID since reused by a live process.
    writeRecord({ kind: "host", lock: "os", pid: process.ppid });
    const release = acquireStateLock(database, { kind: "next" });
    expect(readStateLockRecord(database)).toMatchObject({
      kind: "next",
      pid: process.pid,
    });
    release();
  });

  it("still yields to a live host from before the OS lock", () => {
    writeRecord({ kind: "host", pid: 4242, startedAt: "then" });
    expect(() =>
      acquireStateLock(database, { alive: () => true, busyTimeoutMs: 0 }),
    ).toThrow(StateLockedError);
    acquireStateLock(database, { alive: () => false })();
  });

  it("excludes another process, and is free once it is killed", async () => {
    const child = await holdInChild();
    try {
      expect(isStateLockHeld(database)).toBe(true);
      expect(() => acquireStateLock(database, { busyTimeoutMs: 0 })).toThrow(
        /child/,
      );
    } finally {
      await killed(child);
    }
    // Killed without cleanup: its record remains, its lock does not.
    expect(readStateLockRecord(database)?.kind).toBe("child");
    expect(isStateLockHeld(database)).toBe(false);
    acquireStateLock(database)();
  });

  it("does not remove a record a later host wrote", () => {
    const release = acquireStateLock(database, { now: () => "first" });
    writeRecord({
      kind: "later",
      lock: "os",
      pid: process.pid,
      startedAt: "x",
    });
    release();
    expect(readStateLockRecord(database)?.kind).toBe("later");
  });
});

describe("isStateLockHeld", () => {
  it("reports this process's own lock and its release", () => {
    expect(isStateLockHeld(database)).toBe(false);
    const release = acquireStateLock(database);
    expect(isStateLockHeld(database)).toBe(true);
    release();
    expect(isStateLockHeld(database)).toBe(false);
  });
});
