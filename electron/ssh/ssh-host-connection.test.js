// The connection end to end against a real daemon, with a fake ssh (the
// direct shape) standing in for OpenSSH; and the multiplexed shape's ssh
// calls with a scripted spawner.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import getPort from "get-port";
import { afterAll, expect, test } from "vitest";
import { runDaemonCli } from "../host/daemon.js";
import { createSshHostConnection } from "./ssh-host-connection.js";

const FAKE_SSH = fileURLToPath(
  new URL("./test-fixtures/fake-ssh.js", import.meta.url),
);
const hostHome = mkdtempSync(path.join(os.tmpdir(), "dream-ssh-host-"));
const pidDirectory = mkdtempSync(path.join(os.tmpdir(), "dream-ssh-pids-"));

const quiet = { write: () => {} };
afterAll(async () => {
  await runDaemonCli(["stop", "--home", hostHome], {
    stderr: quiet,
    stdout: quiet,
  });
});

const fakeSshConnection = ({ fail, onStatus } = {}) =>
  createSshHostConnection({
    env: {
      ...process.env,
      FAKE_SSH_FAIL: fail ?? "",
      FAKE_SSH_HOST_HOME: hostHome,
      FAKE_SSH_PID_DIR: pidDirectory,
    },
    getLocalPort: () => getPort({ host: "127.0.0.1" }),
    onStatus,
    setTimer: (callback, ms) => setTimeout(callback, Math.min(ms, 50)),
    spawnProcess: (_ssh, args, options) =>
      spawn(process.execPath, [FAKE_SSH, ...args], options),
    target: "devbox",
  });

const hostInfo = async ({ baseUrl, token }) =>
  (
    await fetch(`${baseUrl}/api/host-info`, {
      headers: { "x-dream-api-token": token },
    })
  ).json();

const waitFor = async (check, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("connects, survives a dropped link, and leaves the daemon running", {
  timeout: 90_000,
}, async () => {
  const states = [];
  const connection = fakeSshConnection({
    onStatus: (status) => states.push(status.state),
  });

  const endpoint = await connection.connect();
  const info = await hostInfo(endpoint);
  expect(info).toMatchObject({ hostProtocolVersion: 1, pid: endpoint.pid });

  // Drop the link: kill the process holding the forward.
  const [forward] = readdirSync(pidDirectory);
  process.kill(Number(forward.replace("forward-", "")));
  await waitFor(() => states.includes("reconnecting"));
  await waitFor(() => states.at(-1) === "connected");

  const again = connection.getEndpoint();
  expect(again.baseUrl).not.toBe(endpoint.baseUrl);
  expect((await hostInfo(again)).pid).toBe(endpoint.pid);

  connection.disconnect();
  expect(connection.getState()).toBe("disconnected");
  const status = await runDaemonCli(["status", "--home", hostHome], {
    stderr: quiet,
    stdout: quiet,
  });
  expect(status).toBe(0);
});

test("a refused key fails without retrying", { timeout: 30_000 }, async () => {
  const connection = fakeSshConnection({ fail: "auth" });

  await expect(connection.connect()).rejects.toMatchObject({
    fatal: true,
    message: expect.stringContaining("Permission denied"),
  });
  expect(connection.getState()).toBe("failed");
});

// ── Multiplexed shape ─────────────────────────────────────────────────────

const createScriptedSpawn = (respond) => {
  const calls = [];
  const spawnProcess = (_ssh, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 143;
      child.emit("exit", 143);
      child.emit("close", 143);
    };
    calls.push({ args, child });
    queueMicrotask(() => {
      const reply = respond(args);
      if (!reply) return; // a held-open session
      child.stdout.end(reply.stdout ?? "");
      child.stderr.end(reply.stderr ?? "");
      child.exitCode = reply.code ?? 0;
      setTimeout(() => {
        child.emit("exit", child.exitCode);
        child.emit("close", child.exitCode);
      }, 0);
    });
    return child;
  };
  return { calls, spawnProcess };
};

test("multiplexed: one master, ensure and forward through it", async () => {
  const { calls, spawnProcess } = createScriptedSpawn((args) => {
    if (args.includes("-M")) return null;
    if (args.includes("check")) return { code: 0 };
    if (args.includes("forward")) return { code: 0 };
    return {
      stdout: `${JSON.stringify({ hostProtocolVersion: 1, pid: 9, port: 7000, token: "t" })}\n`,
    };
  });
  const states = [];
  const connection = createSshHostConnection({
    controlPath: "/cm/%C",
    fetchImpl: async () => new Response(JSON.stringify({ pid: 9 })),
    getLocalPort: async () => 5555,
    onStatus: (status) => states.push(status.state),
    setTimer: (callback) => setTimeout(callback, 0),
    spawnProcess,
    target: "devbox",
  });

  const endpoint = await connection.connect();

  expect(endpoint).toMatchObject({
    baseUrl: "http://127.0.0.1:5555",
    token: "t",
  });
  const kinds = calls.map(({ args }) =>
    args.includes("-M")
      ? "master"
      : args.includes("check")
        ? "check"
        : args.includes("forward")
          ? "forward"
          : "ensure",
  );
  expect(kinds).toEqual(["master", "check", "ensure", "forward"]);
  expect(calls[3].args).toContain("127.0.0.1:5555:127.0.0.1:7000");

  // The master is the link: when it goes, the connection reconnects.
  calls[0].child.kill();
  expect(states.at(-1)).toBe("reconnecting");
  connection.disconnect();
  expect(states.at(-1)).toBe("disconnected");
});

test("cancelling ends the attempt's ssh, so it cannot ask again", async () => {
  // ssh sits waiting on its password prompt.
  const { calls, spawnProcess } = createScriptedSpawn(() => null);
  const states = [];
  const connection = createSshHostConnection({
    getLocalPort: async () => 5555,
    onStatus: (status) => states.push(status.state),
    spawnProcess,
    target: "devbox",
  });

  const connecting = connection.connect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(calls).toHaveLength(1);

  expect(connection.cancel("Cancelled at the SSH prompt.")).toBe(true);

  await expect(connecting).rejects.toMatchObject({
    fatal: true,
    message: "Cancelled at the SSH prompt.",
  });
  expect(calls[0].child.exitCode).not.toBeNull();
  expect(calls).toHaveLength(1);
  expect(states).toEqual(["connecting", "failed"]);
  expect(connection.cancel()).toBe(false);
});

test("a host speaking an unsupported protocol is refused", async () => {
  const { spawnProcess } = createScriptedSpawn(() => ({
    stdout: `${JSON.stringify({ hostProtocolVersion: 99, pid: 1, port: 1, token: "t" })}\n`,
  }));
  const connection = createSshHostConnection({
    getLocalPort: async () => 5555,
    spawnProcess,
    target: "devbox",
  });

  await expect(connection.connect()).rejects.toMatchObject({
    fatal: true,
    message: expect.stringContaining("protocol 99"),
  });
});

test("a port of the host is forwarded here (direct shape, real traffic)", {
  timeout: 60_000,
}, async () => {
  const http = await import("node:http");
  // The host's dev server (the fake ssh's host is this machine).
  const devServer = http.createServer((_request, response) =>
    response.end("hello from the host"),
  );
  await new Promise((resolve) => devServer.listen(0, "127.0.0.1", resolve));
  const remotePort = devServer.address().port;
  const connection = fakeSshConnection();

  try {
    await connection.connect();
    const localPort = await connection.forwardPort(remotePort);
    const body = await (await fetch(`http://127.0.0.1:${localPort}/`)).text();

    expect(body).toBe("hello from the host");
    expect(await connection.forwardPort(remotePort)).toBe(localPort);
  } finally {
    connection.disconnect();
    devServer.close();
  }
});

test("multiplexed: a forwarded port is re-added after a reconnect, same local port", async () => {
  let localPorts = [5555, 6001, 7777];
  const { calls, spawnProcess } = createScriptedSpawn((args) => {
    if (args.includes("-M")) return null;
    if (args.includes("check")) return { code: 0 };
    if (args.includes("forward")) return { code: 0 };
    return {
      stdout: `${JSON.stringify({ hostProtocolVersion: 1, pid: 9, port: 7000, token: "t" })}\n`,
    };
  });
  const connection = createSshHostConnection({
    controlPath: "/cm/%C",
    fetchImpl: async () => new Response(JSON.stringify({ pid: 9 })),
    getLocalPort: async () => localPorts.shift(),
    setTimer: (callback) => setTimeout(callback, 0),
    spawnProcess,
    target: "devbox",
  });
  const forwards = () =>
    calls
      .filter(({ args }) => args.includes("forward"))
      .map(({ args }) => args[args.indexOf("-L") + 1]);

  await connection.connect();
  expect(await connection.forwardPort(3000)).toBe(6001);

  // The master drops; the reconnect re-adds the API forward and this one.
  calls.find(({ args }) => args.includes("-M")).child.kill();
  await waitFor(() => connection.getState() === "connected");
  await waitFor(() => forwards().length === 4);
  localPorts = [];

  expect(forwards()).toEqual([
    "127.0.0.1:5555:127.0.0.1:7000",
    "127.0.0.1:6001:127.0.0.1:3000",
    "127.0.0.1:7777:127.0.0.1:7000",
    "127.0.0.1:6001:127.0.0.1:3000",
  ]);
  connection.disconnect();
});
