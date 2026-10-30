// The host daemon's command line: the host (index.js) running on its own,
// outside the window: on an SSH host, as a service, or as the desktop's own
// child host (desktop-host.js runs `ensureDaemon` with Electron's binary as
// Node).
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
//
// Remote access (serve and ensure): --remote-port <n> also serves paired
// devices on that loopback port (api/remote-app.js); --remote-origin <url>
// (repeatable) names the origin a reverse proxy serves it at, and
// --trust-forwarded-host lets that proxy name the host. --client-dir <dir>
// is the browser client it serves at its root: by default the runtime's own
// `client/` (or the checkout's `dist/`). Pairing is always
// required. Settings, Tailscale setup and pairing commands are CONN-05's.
// `serve --pair` prints a pairing link and QR code once the host listens,
// when remote access is on.
//
// --owner desktop names the desktop as the host's owner in its state lock;
// --diagnostics serves terminal flow-control diagnostics (development).
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
import { REMOTE_COMMANDS, runRemoteCommand } from "./remote-cli.js";
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
import { runtimeContract } from "./runtime-contract.js";
import {
  createServiceManager,
  readInstalledServiceName,
} from "./service/service.js";
import { runServiceCommand } from "./service-cli.js";

const CLI_ENTRY = fileURLToPath(new URL("./dream-host.js", import.meta.url));
/* global __DREAM_HOST_VERSION__ */
// The browser client: beside lib/ in a runtime (scripts/build-host-runtime.mjs),
// the renderer build in a checkout.
const DEFAULT_CLIENT_DIRECTORY = fileURLToPath(
  new URL(
    typeof __DREAM_HOST_VERSION__ === "string" ? "../client/" : "../../dist/",
    import.meta.url,
  ),
);
const START_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 100;

export const EXIT_NOT_RUNNING = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
        redirect: "error",
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
  remotePort: record.remotePort ?? null,
  fingerprint: record.fingerprint ?? null,
  hostId: record.hostId ?? null,
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

/** Thrown by ensureDaemon when no host could be started. */
export class DaemonStartError extends Error {
  /** @param {string} message @param {string | null} [log] */
  constructor(message, log = null) {
    super(message);
    this.name = "DaemonStartError";
    this.log = log;
  }
}

/** The `serve` arguments that carry over from an `ensure` invocation. */
const serveArguments = (values) => {
  const args = [];
  if (values["data-dir"]) args.push("--data-dir", values["data-dir"]);
  if (values["idle-timeout"] !== undefined) {
    args.push("--idle-timeout", values["idle-timeout"]);
  }
  if (values["remote-port"] !== undefined) {
    args.push("--remote-port", values["remote-port"]);
  }
  for (const origin of values["remote-origin"] ?? []) {
    args.push("--remote-origin", origin);
  }
  if (values["trust-forwarded-host"]) args.push("--trust-forwarded-host");
  if (values["client-dir"]) args.push("--client-dir", values["client-dir"]);
  if (values.diagnostics) args.push("--diagnostics");
  if (values.owner) args.push("--owner", values.owner);
  return args;
};

/**
 * The running daemon of `home`, or one started detached: reuses the one
 * this protocol's run record names, starts the installed service when one
 * serves this home, and otherwise starts `serve` itself. Resolves with its
 * run record (token included) and whether it was already running.
 *
 * `env` is the started daemon's environment as well as the lookup's; the
 * desktop adds ELECTRON_RUN_AS_NODE so its own binary runs the host.
 * @param {{
 *   home: string,
 *   runDirectory?: string,
 *   values?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 * }} options
 * @returns {Promise<{ record: any, reused: boolean }>}
 */
export async function ensureDaemon({
  home,
  runDirectory = getRunDirectory(home, HOST_PROTOCOL_VERSION),
  values = {},
  env = process.env,
}) {
  ensurePrivateDirectory(runDirectory);
  const running = await probeDaemon(runDirectory);
  if (running) return { record: running, reused: true };

  // Installed as a service: its manager runs the host, not this launcher
  // (a second process would only find the state lock taken).
  const serviceName = readInstalledServiceName(home);
  const service = (() => {
    if (!serviceName) return null;
    try {
      return createServiceManager({ env, home, name: serviceName });
    } catch {
      return null;
    }
  })();
  if (service?.isInstalled() && service.servesHome(home)) {
    await service.start();
    const started = await waitForDaemon(runDirectory);
    if (!started) {
      throw new DaemonStartError(
        "The host service did not start; run `dream-host service status`.",
      );
    }
    return { record: started, reused: true };
  }

  const release = acquireStartLock(runDirectory);
  if (!release) {
    // Another launcher is starting one; use it.
    const started = await waitForDaemon(runDirectory);
    if (!started) {
      throw new DaemonStartError(
        "Another launcher is starting the host; timed out.",
      );
    }
    return { record: started, reused: true };
  }

  try {
    const logFd = openHostLog(runDirectory);
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, "serve", "--home", home, ...serveArguments(values)],
      {
        cwd: home,
        detached: true,
        env: {
          ...createDaemonEnvironment(env),
          // Run by Electron's binary (the desktop's child host), the host
          // must run as Node too.
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
        stdio: ["ignore", logFd, logFd],
        windowsHide: true,
      },
    );
    closeSync(logFd);
    child.unref();

    const started = await waitForDaemon(runDirectory, {
      child,
      pid: child.pid,
    });
    if (!started) {
      throw new DaemonStartError(
        "The host did not start.",
        path.join(runDirectory, "host.log"),
      );
    }
    return { record: started, reused: false };
  } finally {
    release();
  }
}

async function ensure({ home, runDirectory, values, env, write }) {
  try {
    const { record, reused } = await ensureDaemon({
      env,
      home,
      runDirectory,
      values,
    });
    write({ ...describe(record, { withToken: true }), reused });
    return 0;
  } catch (error) {
    if (!(error instanceof DaemonStartError)) throw error;
    write({
      error: error.message,
      ...(error.log ? { log: error.log } : {}),
    });
    return 1;
  }
}

async function serve({ home, runDirectory, values, log }) {
  if (await probeDaemon(runDirectory)) {
    log(`A host is already running for protocol ${HOST_PROTOCOL_VERSION}.`);
    return 1;
  }

  // Electron's binary running this as Node (the desktop's child host, a
  // checkout service): what the host starts (terminals, agents, an Electron
  // app typed into a terminal) must run as itself.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const idleTimeoutMs = parseIdleTimeoutMs(values["idle-timeout"]);
  const dataDirectory = path.resolve(
    values["data-dir"] ?? getDefaultDataDirectory(home),
  );
  ensurePrivateDirectory(dataDirectory);

  const version = readAppVersion();
  const { createHost } = await import("./index.js");
  const host = createHost({
    // What runs it, named in its state lock: a desktop's own child host
    // says so, so a second host can tell the user which app has the data.
    kind: values.owner === "desktop" ? "desktop" : "daemon",
    diagnosticsEnabled: Boolean(values.diagnostics),
    // `dream-host stop`: a clean shutdown over the local API.
    onShutdownRequest: (reason) => void shutdown(reason),
    clientDirectory: path.resolve(
      values["client-dir"] ?? DEFAULT_CLIENT_DIRECTORY,
    ),
    dataDirectory,
    trackActivity: true,
    version,
  });
  const token = createApiSessionToken();
  const port = await host.listen({
    apiToken: token,
    port: Number(values.port ?? 0),
  });

  let remote = null;
  if (values["remote-port"] !== undefined) {
    const remotePort = Number(values["remote-port"]);
    if (
      !Number.isInteger(remotePort) ||
      remotePort < 0 ||
      remotePort > 65_535
    ) {
      throw new Error(`Invalid --remote-port: ${values["remote-port"]}`);
    }
    remote = await host.listenRemote({
      port: remotePort,
      publicOrigins: values["remote-origin"] ?? [],
      trustForwardedHost: Boolean(values["trust-forwarded-host"]),
    });
    log(
      `Serving paired devices on 127.0.0.1:${remote.port} for ${remote.origins.join(", ")}.`,
    );
  } else {
    // Remote access as saved (`dream-host remote on`), if it is on.
    const access = await host.startRemoteAccess();
    if (access.enabled) {
      log(
        access.ready
          ? `Remote access ready at ${access.origin}.`
          : `Remote access is on but not ready: ${access.problem?.message ?? "starting"}`,
      );
      remote = access.listening ? { port: access.port } : null;
    }
  }

  const { fingerprint, hostId } = host.getHostDescriptor();
  writeHostRecord(runDirectory, {
    fingerprint,
    hostId,
    hostProtocolVersion: HOST_PROTOCOL_VERSION,
    pid: process.pid,
    port,
    remotePort: remote?.port ?? null,
    startedAt: new Date().toISOString(),
    token,
    version,
  });
  log(
    `Dream host ${version ?? "(unknown version)"} (protocol ${HOST_PROTOCOL_VERSION}, ${hostId}) listening on 127.0.0.1:${port}, data in ${dataDirectory}.`,
  );

  // `--pair`: what a headless machine would run next, done at once.
  if (values.pair) {
    if (remote) {
      await runRemoteCommand({
        args: [],
        name: "pair",
        print: (line) => process.stdout.write(`${line}\n`),
        record: { port, token },
        values,
        write: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
      }).catch((error) => log(`Could not create a pairing: ${error.message}`));
    } else {
      log(
        "Remote access is off, so there is nothing to pair with. Turn it on with `dream-host remote on --tailscale` (or `--cloudflare --origin <url>`), then run `dream-host pair`.",
      );
    }
  }

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

/**
 * Stops the running daemon of `runDirectory`; resolves with what happened.
 * It is asked first (it closes, flushing its writes and releasing its lock);
 * only one that does not exit in time is signalled, which on Windows ends
 * it at once.
 */
export const stopRunningDaemon = async (runDirectory) => {
  const running = await probeDaemon(runDirectory);
  if (!running) return { running: false, stopped: false };
  const waitForExit = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && isProcessAlive(running.pid)) {
      await sleep(POLL_MS);
    }
    return !isProcessAlive(running.pid);
  };
  let clean = false;
  try {
    const response = await fetch(
      `http://127.0.0.1:${running.port}/api/host/shutdown`,
      {
        headers: { [API_SESSION_TOKEN_HEADER]: running.token },
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      },
    );
    clean = response.ok && (await waitForExit(STOP_TIMEOUT_MS));
  } catch {
    // An older daemon without the route, or one not answering.
  }
  if (!clean && isProcessAlive(running.pid)) {
    process.kill(running.pid, "SIGTERM");
    await waitForExit(STOP_TIMEOUT_MS);
  }
  const stopped = !isProcessAlive(running.pid);
  return { clean, pid: running.pid, running: !stopped, stopped };
};

async function stop({ runDirectory, write }) {
  const result = await stopRunningDaemon(runDirectory);
  write(result);
  if (!result.pid) return EXIT_NOT_RUNNING;
  return result.stopped ? 0 : 1;
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
    runtime: runtimeContract(),
    version: readAppVersion(),
  });
  return 0;
}

const COMMANDS = { ensure, serve, status, stop, version };

/** A remote-access command, against the running daemon (remote-cli.js). */
const remoteCommand =
  (name) =>
  async ({ args, runDirectory, values, write, stdout }) =>
    runRemoteCommand({
      args,
      name,
      print: (line) => stdout.write(`${line}\n`),
      record: await probeDaemon(runDirectory),
      values,
      write,
    });
for (const name of REMOTE_COMMANDS) COMMANDS[name] = remoteCommand(name);

COMMANDS.service = async ({
  args,
  env,
  home,
  runDirectory,
  values,
  write,
  stdout,
}) =>
  runServiceCommand({
    args,
    env,
    home,
    print: (line) => stdout.write(`${line}\n`),
    probe: () => probeDaemon(runDirectory),
    stopDaemon: async () => (await stopRunningDaemon(runDirectory)).stopped,
    values,
    write,
  });

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
        "remote-origin": { multiple: true, type: "string" },
        "remote-port": { type: "string" },
        "trust-forwarded-host": { type: "boolean" },
        "client-dir": { type: "string" },
        diagnostics: { type: "boolean" },
        owner: { type: "string" },
        pair: { type: "boolean" },
        "https-port": { type: "string" },
        json: { type: "boolean" },
        name: { type: "string" },
        origin: { type: "string" },
        scopes: { type: "string" },
        tailscale: { type: "boolean" },
        cloudflare: { type: "boolean" },
        // Accepted for scripts written when Dream could run cloudflared.
        external: { type: "boolean" },
        env: { multiple: true, type: "string" },
        "service-name": { type: "string" },
        archive: { type: "string" },
        sha256: { type: "string" },
      },
    });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }

  const [name, ...args] = parsed.positionals;
  const command = COMMANDS[name];
  if (!command) {
    stderr.write(
      "Usage: dream-host <ensure|serve|status|stop|version|service|remote|pair|claims|confirm|deny|devices|revoke> [--home dir] [--data-dir dir] [--idle-timeout seconds] [--port n] [--remote-port n] [--remote-origin url]... [--trust-forwarded-host] [--client-dir dir]\n",
    );
    return 2;
  }

  const home = path.resolve(parsed.values.home ?? getHostHome(env));
  const runDirectory = getRunDirectory(home, HOST_PROTOCOL_VERSION);
  if (name !== "version") ensurePrivateDirectory(runDirectory);

  try {
    return await command({
      args,
      env,
      home,
      stdout,
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
