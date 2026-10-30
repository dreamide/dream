// The host's command line: `dream-host`, the standard way to run Dream's
// host (index.js) outside a window. On an SSH host Dream runs `ensure`; the
// desktop starts its own host with `ensure` too (desktop-host.js, with
// Electron's binary as Node); anyone can run `serve` in a terminal or under
// their own service manager.
//
//   serve    Run the host in the foreground.
//   ensure   Reuse the host running for this home and protocol, or start
//            `serve` detached; print {pid, port, token, ...} as one JSON
//            line. The only command that prints the token.
//   status   Print whether a host is running (no token); exit 3 if not.
//   stop     Ask the running host to shut down.
//   version  Print the runtime's version and update contract.
//   help     The commands and every option.
//   remote, pair, claims, confirm, deny, devices, revoke
//            Remote access and paired devices (remote-cli.js).
//
// Every option the host starts with is in host/options.js, as a flag and an
// environment variable (a flag wins over a variable, which wins over a
// saved setting, which wins over the default). `serve --pair` prints a
// pairing link and code once the host listens, when remote access is on.
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
import { createIdleMonitor } from "./idle-monitor.js";
import {
  HostOptionError,
  hostParseArgsOptions,
  passHostFlags,
  renderHostOptionsHelp,
  resolveHostOptions,
} from "./options.js";
import { HOST_PROTOCOL_VERSION } from "./protocol.js";
import { REMOTE_COMMANDS, runRemoteCommand } from "./remote-cli.js";
import {
  acquireStartLock,
  ensurePrivateDirectory,
  getRunDirectory,
  isProcessAlive,
  openHostLog,
  readHostRecord,
  removeHostRecord,
  writeHostRecord,
} from "./run-directory.js";
import { runtimeContract } from "./runtime-contract.js";

const CLI_ENTRY = fileURLToPath(new URL("./dream-host.js", import.meta.url));
/* global __DREAM_HOST_VERSION__ */
// The browser client: beside lib/ in a runtime (scripts/build-host-runtime.mjs),
// the renderer build in a checkout.
export const DEFAULT_CLIENT_DIRECTORY = fileURLToPath(
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

/**
 * The running host of `home`, or one started detached with `flags`: reuses
 * the one this protocol's run record names, and otherwise starts `serve`.
 * Resolves with its run record (token included) and whether it was already
 * running.
 *
 * `env` is the started host's environment as well as the lookup's, so an
 * option set by an environment variable reaches it as one.
 * @param {{
 *   home: string,
 *   runDirectory?: string,
 *   flags?: string[],
 *   env?: NodeJS.ProcessEnv,
 * }} options
 *   `flags`: host options as flags (host/options.js `hostOptionFlags`).
 * @returns {Promise<{ record: any, reused: boolean }>}
 */
export async function ensureDaemon({
  home,
  runDirectory = getRunDirectory(home, HOST_PROTOCOL_VERSION),
  flags = [],
  env = process.env,
}) {
  ensurePrivateDirectory(runDirectory);
  const running = await probeDaemon(runDirectory);
  if (running) return { record: running, reused: true };

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
    const withoutHome = flags.filter(
      (flag, index) => flag !== "--home" && flags[index - 1] !== "--home",
    );
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, "serve", "--home", home, ...withoutHome],
      {
        cwd: home,
        detached: true,
        env: {
          ...createDaemonEnvironment(env),
          // Run by Electron's binary (the desktop's own host), the host
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
      flags: passHostFlags(values),
      home,
      runDirectory,
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

/** The remote access a host was started with (DH-14), or null. */
const remoteOverride = ({ options, from }) =>
  options.remotePort === null
    ? null
    : {
        origins: options.remoteOrigins,
        port: options.remotePort,
        sources: Object.fromEntries(
          ["remotePort", "remoteOrigins", "trustForwardedHost"]
            .filter((name) => from[name])
            .map((name) => [name, from[name]]),
        ),
        trustForwardedHost: options.trustForwardedHost,
      };

async function serve({ runDirectory, values, log, resolved }) {
  if (await probeDaemon(runDirectory)) {
    log(`A host is already running for protocol ${HOST_PROTOCOL_VERSION}.`);
    return 1;
  }

  // Electron's binary running this as Node (the desktop's own host): what
  // the host starts (terminals, agents, an Electron app typed into a
  // terminal) must run as itself.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const { options } = resolved;
  ensurePrivateDirectory(options.dataDir);
  // The host's workers find the state database here (persisted-state.js).
  process.env.DREAM_DB_PATH = options.database;

  const version = readAppVersion();
  const { createHost } = await import("./index.js");
  const host = createHost({
    // What runs it, named in its state lock: a desktop's own host says so,
    // so a second host can tell the user which app has the data, and the
    // record says where this host's run record is (DH-09).
    kind: options.owner === "desktop" ? "desktop" : "daemon",
    lockDetails: { owner: options.owner, runDirectory },
    diagnosticsEnabled: options.diagnostics,
    // `dream-host stop`: a clean shutdown over the local API.
    onShutdownRequest: (reason) => void shutdown(reason),
    clientDirectory: options.clientDir,
    dataDirectory: options.dataDir,
    launch: resolved,
    remoteOverride: remoteOverride(resolved),
    trackActivity: true,
    version,
  });
  const token = createApiSessionToken();
  const port = await host.listen({ apiToken: token, port: options.port });

  // Remote access as saved (`dream-host remote on`), or as its options set it.
  const access = await host.startRemoteAccess();
  if (access.enabled) {
    log(
      access.mode === "proxy"
        ? `Serving paired devices on 127.0.0.1:${access.port}${access.requestedOrigin ? ` for ${access.requestedOrigin}` : ""}.`
        : access.ready
          ? `Remote access ready at ${access.origin}.`
          : `Remote access is on but not ready: ${access.problem?.message ?? "starting"}`,
    );
  }
  const remote = access.listening ? { port: access.port } : null;

  const { fingerprint, hostId } = host.getHostDescriptor();
  writeHostRecord(runDirectory, {
    fingerprint,
    hostId,
    hostProtocolVersion: HOST_PROTOCOL_VERSION,
    owner: options.owner,
    pid: process.pid,
    port,
    remotePort: remote?.port ?? null,
    startedAt: new Date().toISOString(),
    token,
    version,
  });
  log(
    `Dream host ${version ?? "(unknown version)"} (protocol ${HOST_PROTOCOL_VERSION}, ${hostId}) listening on 127.0.0.1:${port}, data in ${options.dataDir}.`,
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
    timeoutMs: options.idleTimeout * 1000,
  });
  monitor.start();
  if (monitor.enabled) {
    log(`Idle shutdown after ${options.idleTimeout}s.`);
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

const COMMAND_SUMMARY = `Usage: dream-host <command> [options]

Commands:
  serve       Run the host in the foreground (--pair: print a pairing link)
  ensure      Reuse the running host, or start one in the background
  status      Whether a host is running (exit 3 if not)
  stop        Stop the running host
  version     The runtime's version and update contract
  remote      Remote access: status, on [--tailscale | --cloudflare --origin url], off, check
  pair        A pairing link and code [--scopes view,operate,manage] [--name name]
  claims, confirm <id>, deny <id>, devices, revoke <id>
              Code requests and paired devices
  help        This text

Options (each also an environment variable; a flag wins):
`;

const help = async ({ stdout }) => {
  stdout.write(`${COMMAND_SUMMARY}${renderHostOptionsHelp()}\n`);
  return 0;
};

const COMMANDS = { ensure, help, serve, status, stop, version };

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
        ...hostParseArgsOptions(),
        help: { type: "boolean" },
        pair: { type: "boolean" },
        // Remote access commands (remote-cli.js).
        "https-port": { type: "string" },
        json: { type: "boolean" },
        name: { type: "string" },
        origin: { type: "string" },
        scopes: { type: "string" },
        tailscale: { type: "boolean" },
        cloudflare: { type: "boolean" },
        // Accepted for scripts written when Dream could run cloudflared.
        external: { type: "boolean" },
      },
    });
  } catch (error) {
    stderr.write(
      `${error.message}\nRun \`dream-host help\` for the options.\n`,
    );
    return 2;
  }

  const [requested, ...args] = parsed.positionals;
  const name = parsed.values.help ? "help" : requested;
  const command = COMMANDS[name];
  if (!command) {
    stderr.write(
      name === "service"
        ? "`dream-host service` was removed: run `dream-host serve` under your own service manager (see Run the host in Dream's docs).\n"
        : COMMAND_SUMMARY.split("\n\nOptions")[0].concat("\n"),
    );
    return 2;
  }

  let resolved;
  try {
    resolved = resolveHostOptions({
      context: { clientDirectory: DEFAULT_CLIENT_DIRECTORY },
      env,
      values: parsed.values,
    });
  } catch (error) {
    if (!(error instanceof HostOptionError)) throw error;
    stderr.write(`${error.message}\n`);
    return 2;
  }

  const home = resolved.options.home;
  const runDirectory = getRunDirectory(home, HOST_PROTOCOL_VERSION);
  if (name !== "version" && name !== "help") {
    ensurePrivateDirectory(runDirectory);
  }

  try {
    return await command({
      args,
      env,
      home,
      stdout,
      log: (line) => stdout.write(`[dream-host] ${line}\n`),
      resolved,
      runDirectory,
      values: parsed.values,
      write: (value) => stdout.write(`${JSON.stringify(value)}\n`),
    });
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : error}\n`);
    return 1;
  }
}
