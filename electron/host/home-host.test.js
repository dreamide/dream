// The home host interface (home-host.js) held against the three objects
// that provide it: a real host in this process (not listening), the
// attachment over fake daemon parts (never started), and the in-process
// fallback, whose members forward to whichever host it wraps.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  createHomeHostAttachment,
  withInProcessFallback,
} from "../desktop-host.js";
import { NO_PROCESS_SESSIONS } from "./home-host.js";
import { createHost } from "./index.js";

/** Each member of the interface and its type. */
const HOME_HOST = {
  close: "function",
  listen: "function",
  mode: "string",
  processSessions: "object",
  startRemoteAccess: "function",
};

const expectHomeHost = (host, { extra = [] } = {}) => {
  expect(Object.keys(host).sort()).toEqual(
    [...Object.keys(HOME_HOST), ...extra].sort(),
  );
  for (const [member, type] of Object.entries(HOME_HOST)) {
    expect(typeof host[member], member).toBe(type);
  }
  expect(["detached", "in-process"]).toContain(host.mode);
  expect(typeof host.processSessions.hasActiveSessions).toBe("function");
  expect(typeof host.processSessions.stopAllProcesses).toBe("function");
};

const directories = [];
const temporaryDirectory = (prefix) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
};

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/** A home host recording each call as `<mode>.<member>`. */
const recordingHost = (mode, calls, { listen = async () => 4321 } = {}) => ({
  mode,
  processSessions: {
    hasActiveSessions: () => {
      calls.push(`${mode}.hasActiveSessions`);
      return mode === "in-process";
    },
    stopAllProcesses: async () => {
      calls.push(`${mode}.stopAllProcesses`);
    },
  },
  listen: async (options) => {
    calls.push(`${mode}.listen`);
    return listen(options);
  },
  startRemoteAccess: async () => {
    calls.push(`${mode}.startRemoteAccess`);
    return { from: mode };
  },
  close: async () => {
    calls.push(`${mode}.close`);
  },
});

test("a host in this process is a home host, with a daemon's two members besides", async () => {
  const host = createHost({
    dataDirectory: temporaryDirectory("dream-home-host-interface-"),
  });
  try {
    expectHomeHost(host, { extra: ["getHostDescriptor", "isBusy"] });
    expect(host.mode).toBe("in-process");
    expect(host.processSessions.hasActiveSessions()).toBe(false);
    expect(host.isBusy()).toBe(false);
    expect(host.getHostDescriptor().hostId).toEqual(expect.any(String));
  } finally {
    await host.close();
  }
});

test("the attachment is a home host whose processes are none in this one", async () => {
  const dataDirectory = temporaryDirectory("dream-home-attachment-interface-");
  const unused = (name) => async () => {
    throw new Error(`${name} was not expected`);
  };
  const attachment = createHomeHostAttachment({
    clientDirectory: path.join(dataDirectory, "client"),
    dataDirectory,
    ensure: unused("ensure"),
    find: unused("find"),
    log: () => {},
    resolveRemoteHost: () => null,
    stateDatabasePath: path.join(dataDirectory, "dream.db"),
    stopDaemon: unused("stopDaemon"),
    version: "1.2.3",
  });

  expectHomeHost(attachment);
  expect(attachment.mode).toBe("detached");
  expect(attachment.processSessions).toBe(NO_PROCESS_SESSIONS);
  expect(attachment.processSessions.hasActiveSessions()).toBe(false);
  // Its host applies its own remote access; closing an edge that never
  // listened stops nothing.
  await expect(attachment.startRemoteAccess()).resolves.toBeUndefined();
  await expect(attachment.close()).resolves.toBeUndefined();
});

test("the fallback is a home host forwarding to the attachment while it serves", async () => {
  const calls = [];
  const attached = recordingHost("detached", calls);
  const host = withInProcessFallback({
    attached,
    createInProcess: () => {
      throw new Error("no fallback expected");
    },
    fallBack: true,
    isHeld: () => false,
    log: () => {},
    stateDatabasePath: "/data/dream.db",
  });
  expectHomeHost(attached);
  expectHomeHost(host);
  const { processSessions } = host;

  expect(await host.listen({ apiToken: "t", port: 0 })).toBe(4321);
  expect(await host.startRemoteAccess()).toEqual({ from: "detached" });
  expect(host.processSessions.hasActiveSessions()).toBe(false);
  await host.processSessions.stopAllProcesses();
  await host.close();

  expect(host.mode).toBe("detached");
  expect(host.processSessions).toBe(processSessions);
  expect(calls).toEqual([
    "detached.listen",
    "detached.startRemoteAccess",
    "detached.hasActiveSessions",
    "detached.stopAllProcesses",
    "detached.close",
  ]);
});

test("after falling back, every member forwards to the host in this process", async () => {
  const calls = [];
  const attached = recordingHost("detached", calls, {
    listen: async () => {
      throw new Error("no host");
    },
  });
  const inProcess = recordingHost("in-process", calls);
  const host = withInProcessFallback({
    attached,
    createInProcess: () => {
      calls.push("createInProcess");
      return inProcess;
    },
    fallBack: true,
    isHeld: () => false,
    log: () => {},
    stateDatabasePath: "/data/dream.db",
  });
  expectHomeHost(inProcess);
  // Read once, before listening, as main.js does.
  const { processSessions } = host;

  expect(await host.listen({ apiToken: "t", port: 0 })).toBe(4321);
  expect(host.mode).toBe("in-process");
  expectHomeHost(host);
  expect(await host.startRemoteAccess()).toEqual({ from: "in-process" });
  expect(processSessions.hasActiveSessions()).toBe(true);
  await processSessions.stopAllProcesses();
  await host.close();

  expect(host.processSessions).toBe(processSessions);
  expect(calls).toEqual([
    "detached.listen",
    "detached.close",
    "createInProcess",
    "in-process.listen",
    "in-process.startRemoteAccess",
    "in-process.hasActiveSessions",
    "in-process.stopAllProcesses",
    "in-process.close",
  ]);
});
