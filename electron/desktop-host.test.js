// The desktop's home host end to end: real detached hosts on a temporary
// desktop data directory, attached through the edge listener.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, test } from "vitest";
import { API_SESSION_TOKEN_HEADER } from "./api/shared/session-token.js";
import {
  childHostHome,
  createHomeHostAttachment,
  findRunningHost,
  withInProcessFallback,
} from "./desktop-host.js";
import { ensureDaemon, probeDaemon, stopRunningDaemon } from "./host/daemon.js";
import { hostOptionFlags } from "./host/options.js";
import { HOST_PROTOCOL_VERSION } from "./host/protocol.js";
import { getRunDirectory } from "./host/run-directory.js";
import {
  acquireStateLock,
  isStateLockHeld,
  readStateLockRecord,
  stateLockPaths,
} from "./host/state-lock.js";

const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "dream-home-host-"));
const stateDatabasePath = path.join(dataDirectory, "dream.db");
// The user's own `dream-host` home, kept out of the real ~/.dream/host.
const userHome = mkdtempSync(path.join(os.tmpdir(), "dream-user-host-"));
const env = { ...process.env, DREAM_DB_PATH: "", DREAM_HOST_HOME: userHome };
const desktopRun = getRunDirectory(
  childHostHome(stateDatabasePath),
  HOST_PROTOCOL_VERSION,
);
const userRun = getRunDirectory(userHome, HOST_PROTOCOL_VERSION);
const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const attach = ({ appVersion = version } = {}) =>
  createHomeHostAttachment({
    clientDirectory: path.join(dataDirectory, "client"),
    dataDirectory,
    env,
    log: () => {},
    resolveRemoteHost: () => null,
    stateDatabasePath,
    version: appVersion,
  });

const hostInfo = async (port) => {
  const response = await fetch(`http://127.0.0.1:${port}/api/host-info`, {
    headers: { [API_SESSION_TOKEN_HEADER]: "edge-token" },
  });
  expect(response.ok).toBe(true);
  return response.json();
};

const listen = async (edge) =>
  hostInfo(await edge.listen({ apiToken: "edge-token", port: 0 }));

afterEach(async () => {
  await stopRunningDaemon(desktopRun);
  await stopRunningDaemon(userRun);
});

afterAll(() => {
  rmSync(dataDirectory, { force: true, recursive: true });
  rmSync(userHome, { force: true, recursive: true });
});

test("the desktop starts its own host when none runs, and stops it", {
  timeout: 120_000,
}, async () => {
  const edge = attach();
  const info = await listen(edge);
  expect(info.pid).not.toBe(process.pid);
  expect(edge.describe()).toMatchObject({
    owned: true,
    runDirectory: desktopRun,
  });
  expect(readStateLockRecord(stateDatabasePath)).toMatchObject({
    kind: "desktop",
    owner: "desktop",
    pid: info.pid,
    runDirectory: desktopRun,
  });

  // The edge's own credential guards it; the host's never leaves it.
  const refused = await fetch(
    `http://127.0.0.1:${(await probeDaemon(desktopRun)).port}/api/host-info`,
  );
  expect(refused.status).toBe(401);

  await edge.close();
  expect(await probeDaemon(desktopRun)).toBeNull();
  expect(isStateLockHeld(stateDatabasePath)).toBe(false);
});

test("a host the user started is attached to and left running", {
  timeout: 120_000,
}, async () => {
  const { record } = await ensureDaemon({
    env,
    flags: hostOptionFlags({
      dataDir: dataDirectory,
      database: stateDatabasePath,
      idleTimeout: 0,
    }),
    home: userHome,
  });
  const edge = attach({ appVersion: "999.0.0" });
  const info = await listen(edge);
  // Its version is not this app's, and it is attached to all the same.
  expect(info.pid).toBe(record.pid);
  expect(edge.describe()).toMatchObject({
    owned: false,
    runDirectory: userRun,
  });

  await edge.close();
  expect((await probeDaemon(userRun))?.pid).toBe(record.pid);
});

test("a desktop's host left running is reused, or replaced for another version", {
  timeout: 120_000,
}, async () => {
  // A desktop that crashed: its host still runs, owned by a desktop.
  const first = attach();
  const firstPid = (await listen(first)).pid;

  const again = attach();
  expect((await listen(again)).pid).toBe(firstPid);
  expect(again.describe().owned).toBe(true);

  const upgraded = attach({ appVersion: "999.0.0" });
  expect((await listen(upgraded)).pid).not.toBe(firstPid);
  await upgraded.close();
  expect(await probeDaemon(desktopRun)).toBeNull();
});

test("a host from before the lock named its run directory is still found", async () => {
  // A v0.31 host: a PID-only lock record, its run record in the default home.
  writeFileSync(
    stateLockPaths(stateDatabasePath).record,
    JSON.stringify({ kind: "daemon", pid: process.pid, startedAt: "then" }),
  );
  try {
    const probe = async (runDirectory) =>
      runDirectory === userRun ? { pid: process.pid, version: "0.31.0" } : null;
    expect(await findRunningHost(stateDatabasePath, { env, probe })).toEqual({
      owner: "user",
      record: { pid: process.pid, version: "0.31.0" },
      runDirectory: userRun,
    });
  } finally {
    rmSync(stateLockPaths(stateDatabasePath).record, { force: true });
  }
});

test("data held by a host that cannot be reached is refused with a reason", async () => {
  const release = acquireStateLock(stateDatabasePath, { kind: "desktop" });
  try {
    expect(await findRunningHost(stateDatabasePath, { env })).toMatchObject({
      unreachable: true,
    });
    await expect(
      attach().listen({ apiToken: "edge-token", port: 0 }),
    ).rejects.toThrow(/cannot be reached from here/);
  } finally {
    release();
  }
});

test("a host that cannot start falls back to a host in this process", async () => {
  const failing = {
    close: async () => {},
    describe: () => ({ owned: true }),
    listen: async () => {
      throw new Error("no host");
    },
    processSessions: { hasActiveSessions: () => false },
  };
  const inProcess = {
    close: async () => {},
    listen: async () => 4321,
    processSessions: { hasActiveSessions: () => true },
    startRemoteAccess: async () => ({ enabled: false }),
  };
  const logged = [];
  const host = withInProcessFallback({
    attached: failing,
    createInProcess: () => inProcess,
    fallBack: true,
    isHeld: () => false,
    log: (message) => logged.push(message),
    stateDatabasePath,
  });
  expect(host.mode).toBe("detached");
  expect(await host.listen({ apiToken: "t", port: 0 })).toBe(4321);
  expect(host.mode).toBe("in-process");
  expect(host.processSessions.hasActiveSessions()).toBe(true);
  expect(logged).toHaveLength(1);

  // With the data held by another host: no fallback.
  const strict = withInProcessFallback({
    attached: failing,
    createInProcess: () => inProcess,
    fallBack: true,
    isHeld: () => true,
    log: () => {},
    stateDatabasePath,
  });
  await expect(strict.listen({ apiToken: "t", port: 0 })).rejects.toThrow(
    "no host",
  );
  expect(strict.mode).toBe("detached");
});
