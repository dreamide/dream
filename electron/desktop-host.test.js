// The desktop's child host end to end: a real detached daemon on a
// temporary desktop data directory, attached through the edge listener.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { API_SESSION_TOKEN_HEADER } from "./api/shared/session-token.js";
import {
  childHostHome,
  createChildHostAttachment,
  serviceServesDesktop,
  withInProcessFallback,
} from "./desktop-host.js";
import { probeDaemon, stopRunningDaemon } from "./host/daemon.js";
import { HOST_PROTOCOL_VERSION } from "./host/protocol.js";
import { getRunDirectory } from "./host/run-directory.js";
import { writeServiceJson } from "./host/service/operation.js";
import { isStateLockHeld, readStateLockRecord } from "./host/state-lock.js";

const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "dream-child-host-"));
const stateDatabasePath = path.join(dataDirectory, "dream.db");
const runDirectory = getRunDirectory(
  childHostHome(stateDatabasePath),
  HOST_PROTOCOL_VERSION,
);
const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const attach = ({ keepRunning = false, appVersion = version } = {}) =>
  createChildHostAttachment({
    clientDirectory: path.join(dataDirectory, "client"),
    dataDirectory,
    keepRunning: () => keepRunning,
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

afterAll(async () => {
  await stopRunningDaemon(runDirectory);
  rmSync(dataDirectory, { force: true, recursive: true });
});

test("the child host serves through the edge and stops when it closes", {
  timeout: 120_000,
}, async () => {
  const edge = attach();
  const port = await edge.listen({ apiToken: "edge-token", port: 0 });
  const info = await hostInfo(port);
  expect(info.pid).not.toBe(process.pid);
  expect(readStateLockRecord(stateDatabasePath)).toMatchObject({
    kind: "desktop",
    pid: info.pid,
  });

  // The edge's own credential guards it; the host's never leaves it.
  const refused = await fetch(`http://127.0.0.1:${port}/api/host-info`);
  expect(refused.status).toBe(401);
  const shutdown = await fetch(`http://127.0.0.1:${port}/api/host/shutdown`, {
    headers: { [API_SESSION_TOKEN_HEADER]: "edge-token" },
    method: "POST",
  });
  expect(shutdown.status).toBe(409);

  await edge.close();
  expect(await probeDaemon(runDirectory)).toBeNull();
  expect(isStateLockHeld(stateDatabasePath)).toBe(false);
});

test("a host kept running is reattached, and replaced for another version", {
  timeout: 120_000,
}, async () => {
  const first = attach({ keepRunning: true });
  const firstPid = (
    await hostInfo(await first.listen({ apiToken: "edge-token", port: 0 }))
  ).pid;
  await first.close();
  expect((await probeDaemon(runDirectory))?.pid).toBe(firstPid);

  const again = attach({ keepRunning: true });
  const againPid = (
    await hostInfo(await again.listen({ apiToken: "edge-token", port: 0 }))
  ).pid;
  expect(againPid).toBe(firstPid);
  await again.close();

  const upgraded = attach({ appVersion: "999.0.0" });
  const upgradedPid = (
    await hostInfo(await upgraded.listen({ apiToken: "edge-token", port: 0 }))
  ).pid;
  expect(upgradedPid).not.toBe(firstPid);
  await upgraded.close();
  expect(await probeDaemon(runDirectory)).toBeNull();
});

test("a child host that cannot start falls back to a host in this process", async () => {
  const failing = {
    close: async () => {},
    listen: async () => {
      throw new Error("no child");
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
  expect(host.mode).toBe("child");
  expect(await host.listen({ apiToken: "t", port: 0 })).toBe(4321);
  expect(host.mode).toBe("in-process");
  expect(host.processSessions.hasActiveSessions()).toBe(true);
  expect(logged).toHaveLength(1);

  // Asked for explicitly, or with the data held by another host: no fallback.
  for (const options of [{ fallBack: false }, { isHeld: () => true }]) {
    const strict = withInProcessFallback({
      attached: failing,
      createInProcess: () => inProcess,
      fallBack: true,
      isHeld: () => false,
      log: () => {},
      stateDatabasePath,
      ...options,
    });
    await expect(strict.listen({ apiToken: "t", port: 0 })).rejects.toThrow(
      "no child",
    );
    expect(strict.mode).toBe("child");
  }
});

test("an installed service is attached only when it serves this desktop's data", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "dream-service-home-"));
  const other = mkdtempSync(path.join(os.tmpdir(), "dream-other-data-"));
  try {
    const manager = { isInstalled: () => true, servesHome: () => true };
    const record = (dataDir, environment = {}) =>
      writeServiceJson(path.join(home, "service.json"), {
        definition: "unit",
        launch: {
          args: ["serve", "--home", home, "--data-dir", dataDir],
          environment,
        },
        name: "dream-host",
      });
    const serves = (createManager = () => manager) =>
      serviceServesDesktop({
        createManager,
        dataDirectory,
        home,
        stateDatabasePath,
      });

    expect(serves()).toBe(false);
    record(dataDirectory);
    expect(serves()).toBe(true);
    expect(
      serves(() => ({ isInstalled: () => false, servesHome: () => true })),
    ).toBe(false);
    record(other);
    expect(serves()).toBe(false);
    // Same directory, another database (a development DREAM_DB_PATH).
    record(dataDirectory, { DREAM_DB_PATH: path.join(other, "dev.db") });
    expect(serves()).toBe(false);
  } finally {
    rmSync(home, { force: true, recursive: true });
    rmSync(other, { force: true, recursive: true });
  }
});
