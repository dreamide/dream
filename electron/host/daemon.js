// The host daemon's command line: the host (index.js) running on its own,
// outside Electron, on an SSH host.
//
//   ensure   Reuse the running daemon for this protocol version, or start
//            one detached; print {pid, port, token, ...} as one JSON line.
//            This is what a launcher runs over SSH, and the only command
//            that prints the token.
//   serve    Run the daemon in the foreground (ensure starts one of these).
//   status   Print whether a daemon is running (no token); exit 3 if not.
//   stop     Ask the running daemon to shut down.
//
// Options: --home <dir> (default ~/.dream/host, or DREAM_HOST_HOME),
// --data-dir <dir> (default <home>/data), --idle-timeout <seconds> (0 never
// idles out), --port <n> (serve only; default a free port).
import { spawn } from "node:child_process";
import { closeSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  API_SESSION_TOKEN_HEADER,
  createApiSessionToken,
} from "../api/shared/session-token.js";
import { createDaemonEnvironment } from "./daemon-environment.js";
import { createIdleMonitor, DEFAULT_IDLE_TIMEOUT_MS } from "./idle-monitor.js";
import { HOST_PROTOCOL_VERSION } from "./protocol.js";
import {
  acquireStartLock,
  ensurePrivateDirectory,
  getDefaultDataDirectory,
  getHostHome,
  getRunDirectory,
  isProcessAlive,
  openHostLog,
  readHostRecord,
  removeHostRecord,
  writeHostRecord,
} from "./run-directory.js";

const CLI_ENTRY = fileURLToPath(new URL("./dream-host.js", import.meta.url));
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

export const EXIT_NOT_RUNNING = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* global __DREAM_HOST_VERSION__ */
// The packaged runtime has its version built in (scripts/build-host-runtime.mjs);
// from a checkout it comes from package.json.
const readAppVersion = () => {
  if (typeof __DREAM_HOST_VERSION__ === "string") {
    return __DREAM_HOST_VERSION__;
  }
  try {
    return JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ).version;
  } catch {
    return null;
  }
};

const parseIdleTimeoutMs = (value) => {
  if (value === undefined) return DEFAULT_IDLE_TIMEOUT_MS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid --idle-timeout: ${value}`);
  }
  return seconds * 1000;
};

/**
 * The running daemon for this protocol version, verified by asking it, or
 * null. A record whose process is gone or that does not answer is ignored.
 */
export async function probeDaemon(runDirectory) {
  const record = readHostRecord(runDirectory);
  if (!record || !isProcessAlive(record.pid)) return null;
  try {
    const response = await fetch(
      `http://127.0.0.1:${record.port}/api/host-info`,
      {
        headers: { [API_SESSION_TOKEN_HEADER]: record.token },
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (!response.ok) return null;
    const info = await response.json();
    if (
      info?.hostProtocolVersion !== HOST_PROTOCOL_VERSION ||
      info?.pid !== record.pid
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

const describe = (record, { withToken = false } = {}) => ({
  hostProtocolVersion: record.hostProtocolVersion,
  pid: record.pid,
  port: record.port,
  startedAt: record.startedAt,
  ...(withToken ? { token: record.token } : {}),
  version: record.version,
});

const waitForDaemon = async (runDirectory, { pid, child } = {}) => {
  let exited = false;
  child?.once("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const record = await probeDaemon(runDirectory);
    if (record && (pid === undefined || record.pid === pid)) return record;
    if (exited) return null;
    await sleep(POLL_MS);
  }
  return null;
};

async function ensure({ home, runDirectory, values, env, write }) {
  const running = await probeDaemon(runDirectory);
  if (running) {
    write({ ...describe(running, { withToken: true }), reused: true });
    return 0;
  }

  const release = acquireStartLock(runDirectory);
  if (!release) {
    // Another launcher is starting one; use it.
    const started = await waitForDaemon(runDirectory);
    if (!started) {
      write({ error: "Another launcher is starting the host; timed out." });
      return 1;
    }
    write({ ...describe(started, { withToken: true }), reused: true });
    return 0;
  }

  try {
    const logFd = openHostLog(runDirectory);
    const args = [CLI_ENTRY, "serve", "--home", home];
    if (values["data-dir"]) args.push("--data-dir", values["data-dir"]);
    if (values["idle-timeout"] !== undefined) {
      args.push("--idle-timeout", values["idle-timeout"]);
    }
    const child = spawn(process.execPath, args, {
      cwd: home,
      detached: true,
      env: createDaemonEnvironment(env),
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    closeSync(logFd);
    child.unref();

    const started = await waitForDaemon(runDirectory, {
      child,
      pid: child.pid,
    });
    if (!started) {
      write({
        error: "The host did not start.",
        log: path.join(runDirectory, "host.log"),
      });
      return 1;
    }
    write({ ...describe(started, { withToken: true }), reused: false });
    return 0;
  } finally {
    release();
  }
}

async function serve({ home, runDirectory, values, log }) {
  if (await probeDaemon(runDirectory)) {
    log(`A host is already running for protocol ${HOST_PROTOCOL_VERSION}.`);
    return 1;
  }

  const idleTimeoutMs = parseIdleTimeoutMs(values["idle-timeout"]);
  const dataDirectory = path.resolve(
    values["data-dir"] ?? getDefaultDataDirectory(home),
  );
  ensurePrivateDirectory(dataDirectory);

  const version = readAppVersion();
  const { createHost } = await import("./index.js");
  const host = createHost({ dataDirectory, trackActivity: true, version });
  const token = createApiSessionToken();
  const port = await host.listen({
    apiToken: token,
    port: Number(values.port ?? 0),
  });

  writeHostRecord(runDirectory, {
    hostProtocolVersion: HOST_PROTOCOL_VERSION,
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    token,
    version,
  });
  log(
    `Dream host ${version ?? "(unknown version)"} (protocol ${HOST_PROTOCOL_VERSION}) listening on 127.0.0.1:${port}, data in ${dataDirectory}.`,
  );

  let stopping = false;
  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    log(`Shutting down (${reason}).`);
    monitor.stop();
    // Unlist first, so no launcher reuses a daemon that is going away.
    removeHostRecord(runDirectory, process.pid);
    try {
      await host.close();
    } finally {
      process.exit(0);
    }
  };

  const monitor = createIdleMonitor({
    isBusy: host.isBusy,
    onIdle: () => void shutdown("idle"),
    timeoutMs: idleTimeoutMs,
  });
  monitor.start();
  if (monitor.enabled) {
    log(`Idle shutdown after ${Math.round(idleTimeoutMs / 1000)}s.`);
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => void shutdown(signal));
  }

  // Runs until shutdown exits the process.
  return new Promise(() => {});
}

async function stop({ runDirectory, write }) {
  const running = await probeDaemon(runDirectory);
  if (!running) {
    write({ running: false, stopped: false });
    return EXIT_NOT_RUNNING;
  }

  process.kill(running.pid, "SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && isProcessAlive(running.pid)) {
    await sleep(POLL_MS);
  }
  const stopped = !isProcessAlive(running.pid);
  write({ pid: running.pid, running: !stopped, stopped });
  return stopped ? 0 : 1;
}

async function status({ runDirectory, write }) {
  const running = await probeDaemon(runDirectory);
  if (!running) {
    write({ running: false });
    return EXIT_NOT_RUNNING;
  }
  write({ running: true, ...describe(running) });
  return 0;
}

/** Prints the runtime's version and protocol (a smoke test after install). */
async function version({ write }) {
  write({
    hostProtocolVersion: HOST_PROTOCOL_VERSION,
    version: readAppVersion(),
  });
  return 0;
}

const COMMANDS = { ensure, serve, status, stop, version };

/**
 * Runs one command. Resolves with the exit code (`serve` never resolves).
 * @param {string[]} argv
 */
export async function runDaemonCli(
  argv,
  { env = process.env, stdout = process.stdout, stderr = process.stderr } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      args: argv,
      options: {
        "data-dir": { type: "string" },
        home: { type: "string" },
        "idle-timeout": { type: "string" },
        port: { type: "string" },
      },
    });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }

  const [name] = parsed.positionals;
  const command = COMMANDS[name];
  if (!command) {
    stderr.write(
      "Usage: dream-host <ensure|serve|status|stop|version> [--home dir] [--data-dir dir] [--idle-timeout seconds] [--port n]\n",
    );
    return 2;
  }

  const home = path.resolve(parsed.values.home ?? getHostHome(env));
  const runDirectory = getRunDirectory(home, HOST_PROTOCOL_VERSION);
  ensurePrivateDirectory(runDirectory);

  try {
    return await command({
      env,
      home,
      log: (line) => stdout.write(`[dream-host] ${line}\n`),
      runDirectory,
      values: parsed.values,
      write: (value) => stdout.write(`${JSON.stringify(value)}\n`),
    });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
}
