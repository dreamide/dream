import { mkdtempSync, statSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  acquireStartLock,
  ensurePrivateDirectory,
  getRunDirectory,
  isProcessAlive,
  readHostRecord,
  removeHostRecord,
  writeHostRecord,
} from "./run-directory.js";

const createRunDirectory = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "dream-host-run-"));
  const runDirectory = getRunDirectory(home, 1);
  ensurePrivateDirectory(runDirectory);
  return runDirectory;
};

test("the run directory and record are private to their owner", () => {
  const runDirectory = createRunDirectory();
  writeHostRecord(runDirectory, { pid: 1, port: 2, token: "t" });

  expect(readHostRecord(runDirectory)).toEqual({ pid: 1, port: 2, token: "t" });
  if (process.platform !== "win32") {
    expect(statSync(runDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(runDirectory, "host.json")).mode & 0o777).toBe(
      0o600,
    );
  }
});

test("a record is removed only by the daemon it describes", () => {
  const runDirectory = createRunDirectory();
  writeHostRecord(runDirectory, { pid: 10, port: 2, token: "t" });

  removeHostRecord(runDirectory, 11);
  expect(readHostRecord(runDirectory)?.pid).toBe(10);
  removeHostRecord(runDirectory, 10);
  expect(readHostRecord(runDirectory)).toBeNull();
});

test("one launcher holds the start lock until it releases it", () => {
  const runDirectory = createRunDirectory();
  const release = acquireStartLock(runDirectory);

  expect(release).toBeTypeOf("function");
  expect(acquireStartLock(runDirectory)).toBeNull();
  release();
  const again = acquireStartLock(runDirectory);
  expect(again).toBeTypeOf("function");
  again();
});

test("a stale start lock is taken over", () => {
  const runDirectory = createRunDirectory();
  acquireStartLock(runDirectory);
  const old = new Date(Date.now() - 120_000);
  utimesSync(path.join(runDirectory, "start.lock"), old, old);

  const release = acquireStartLock(runDirectory, { staleMs: 60_000 });
  expect(release).toBeTypeOf("function");
  release();
});

test("tells a live process from a gone one", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(0)).toBe(false);
  expect(isProcessAlive(2 ** 22 + 12_345)).toBe(false);
});
