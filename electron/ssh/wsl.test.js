// WSL as a host: its targets and wsl.exe's arguments, and a connection end
// to end against a real daemon with a fake wsl.exe.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, test } from "vitest";
import { runDaemonCli } from "../host/daemon.js";
import { createSshHostConnection } from "./ssh-host-connection.js";
import {
  buildWslEnsureArgs,
  buildWslHoldArgs,
  buildWslUploadArgs,
  decodeWslOutput,
  listWslDistributions,
  parseWslDistributions,
  parseWslTarget,
  wslTarget,
  wslWindowsPath,
} from "./wsl.js";

describe("WSL targets and arguments", () => {
  it("names a distribution as wsl:<name>", () => {
    expect(parseWslTarget("wsl:Ubuntu-24.04")).toBe("Ubuntu-24.04");
    expect(parseWslTarget(wslTarget("Debian"))).toBe("Debian");
    for (const other of ["devbox", "wsl:", "wsl:a b", "wsl:-rm", null]) {
      expect(parseWslTarget(other)).toBeNull();
    }
  });

  it("runs commands in the distribution through sh", () => {
    expect(buildWslHoldArgs({ distribution: "Ubuntu" })).toEqual([
      "-d",
      "Ubuntu",
      "--exec",
      "sh",
      "-c",
      "cat >/dev/null",
    ]);
    const ensure = buildWslEnsureArgs({
      distribution: "Ubuntu",
      hostCommand: "dream-host",
    });
    expect(ensure.slice(0, 5)).toEqual(["-d", "Ubuntu", "--exec", "sh", "-c"]);
    expect(ensure.at(-1)).toMatch(/'dream-host ensure'$/);
    expect(() =>
      buildWslUploadArgs({ distribution: "Ubuntu", remotePath: "../x" }),
    ).toThrow(/Unsafe/);
  });

  it("reads wsl.exe's own UTF-16 output and its UTF-8 output", () => {
    const utf16 = Buffer.from("﻿Ubuntu\r\nDebian\r\n", "utf16le");
    expect(parseWslDistributions(decodeWslOutput(utf16))).toEqual([
      "Ubuntu",
      "Debian",
    ]);
    expect(
      parseWslDistributions(decodeWslOutput(Buffer.from("Ubuntu\n\n"))),
    ).toEqual(["Ubuntu"]);
  });

  it("lists nothing off Windows, and the distributions on it", async () => {
    expect(await listWslDistributions({ platform: "linux" })).toEqual([]);
    const spawnProcess = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.write(Buffer.from("Ubuntu\r\n", "utf16le"));
        child.emit("close", 0);
      });
      return child;
    };
    expect(
      await listWslDistributions({ platform: "win32", spawnProcess }),
    ).toEqual(["Ubuntu"]);
  });

  it("names a distribution's path as Windows sees it", () => {
    expect(wslWindowsPath("Ubuntu", "/home/me/app")).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\app",
    );
  });
});

const FAKE_WSL = fileURLToPath(
  new URL("./test-fixtures/fake-wsl.js", import.meta.url),
);
const hostHome = mkdtempSync(path.join(os.tmpdir(), "dream-wsl-host-"));
const pidDirectory = mkdtempSync(path.join(os.tmpdir(), "dream-wsl-pids-"));
const quiet = { write: () => {} };

afterAll(async () => {
  await runDaemonCli(["stop", "--home", hostHome], {
    stderr: quiet,
    stdout: quiet,
  });
});

const fakeWslConnection = ({ missing = false, onStatus } = {}) =>
  createSshHostConnection({
    env: {
      ...process.env,
      FAKE_WSL_HOST_HOME: hostHome,
      FAKE_WSL_MISSING: missing ? "1" : "",
      FAKE_WSL_PID_DIR: pidDirectory,
    },
    getLocalPort: () => {
      throw new Error("A WSL host needs no forwarded port.");
    },
    onStatus,
    setTimer: (callback, ms) => setTimeout(callback, Math.min(ms, 50)),
    spawnProcess: (_wsl, args, options) =>
      spawn(process.execPath, [FAKE_WSL, ...args], options),
    sshPath: "wsl.exe",
    target: "wsl:Ubuntu",
    wslDistribution: "Ubuntu",
  });

const waitFor = async (check, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("a WSL host connects on its own port and reconnects", {
  timeout: 90_000,
}, async () => {
  const states = [];
  const connection = fakeWslConnection({
    onStatus: (status) => states.push(status.state),
  });
  const endpoint = await connection.connect();
  const info = await (
    await fetch(`${endpoint.baseUrl}/api/host-info`, {
      headers: { "x-dream-api-token": endpoint.token },
    })
  ).json();
  expect(info.pid).toBe(endpoint.pid);
  expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  // A port the host serves is reached at the same number.
  expect(await connection.forwardPort(5173)).toBe(5173);

  // The link ends (the distribution stopped): it reconnects.
  await waitFor(() => readdirSync(pidDirectory).length > 0);
  const [hold] = readdirSync(pidDirectory);
  process.kill(Number(hold.replace("hold-", "")));
  await waitFor(() => states.includes("reconnecting"));
  await waitFor(() => states.at(-1) === "connected");
  expect(connection.getEndpoint().pid).toBe(endpoint.pid);
  connection.disconnect();
});

test("a missing distribution fails without retrying", {
  timeout: 30_000,
}, async () => {
  const connection = fakeWslConnection({ missing: true });
  await expect(connection.connect()).rejects.toMatchObject({
    fatal: true,
    message: expect.stringContaining("no distribution"),
  });
});
