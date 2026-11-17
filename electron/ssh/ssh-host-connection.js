// One link from this machine to the host daemon on an SSH host: run
// `dream-host ensure` there, forward a loopback port to the daemon and check
// it answers.
//
//   connect()     resolves with the endpoint or rejects with why. A failure
//                 on authentication, the host key or the protocol is
//                 `fatal`: trying again cannot help.
//   (dropped)     a lost session ends the link: the state becomes
//                 `disconnected` with its error. It is not re-established
//                 here; the route supervisor dials a new link.
//   disconnect()  ends the session. The daemon is never stopped: its
//                 terminals and turns keep running for the next connect.
//   cancel()      stops an attempt in flight (the user declined an ssh
//                 prompt): its ssh processes end, so ssh cannot ask again.
//
// Which host the link reached (the host-info's identity) is reported in the
// endpoint; whether it is the host a connection expects is the route
// supervisor's question.
//
// Electron-free: the process spawner, port picker, fetch and timers are
// injected, so it runs under plain Node and in tests.
import { spawn as spawnChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import net from "node:net";
import { API_SESSION_TOKEN_HEADER } from "../api/shared/session-token.js";
import {
  hostProtocolProblem,
  requestHostInfo,
} from "../shared/host-verification.js";
import {
  buildInstallScript,
  buildPlatformScript,
  downloadRuntimeArchive,
  INSTALL_EXIT,
  managedHostCommand,
  parsePlatform,
} from "./host-install.js";
import {
  buildDirectForwardArgs,
  buildEnsureArgs,
  buildMasterArgs,
  buildMasterCheckArgs,
  buildMasterForwardArgs,
  buildScriptArgs,
  buildUploadArgs,
} from "./ssh-args.js";

const MASTER_READY_TIMEOUT_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 15_000;
const POLL_MS = 200;

const FATAL_SSH_ERRORS =
  /Permission denied|Host key verification failed|Too many authentication failures|REMOTE HOST IDENTIFICATION HAS CHANGED/i;

export class SshHostError extends Error {
  /**
   * @param {string} message
   * @param {{ fatal?: boolean, detail?: string, cancelled?: boolean }} [options]
   *   `fatal`: retrying cannot help (authentication, host key, protocol).
   */
  constructor(message, { fatal = false, detail = "", cancelled = false } = {}) {
    super(message);
    this.name = "SshHostError";
    this.fatal = fatal;
    this.detail = detail;
    this.cancelled = cancelled;
  }
}

const lastLine = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";

/**
 * @param {{
 *   target: string,
 *   sshPath?: string,
 *   controlPath?: string | null,
 *   env?: Record<string, string | undefined>,
 *   getLocalPort: () => Promise<number>,
 *   onStatus?: (status: object) => void,
 *   spawnProcess?: typeof spawnChildProcess,
 *   fetchImpl?: typeof fetch,
 *   setTimer?: (callback: () => void, ms: number) => unknown,
 *   now?: () => number,
 *   isLocalPortOpen?: (port: number) => Promise<boolean>,
 *   runtimeVersion?: string | null,
 *   runtimeBaseUrl?: string,
 *   runtimeCacheDirectory?: string | null,
 *   interactive?: boolean,
 * }} options
 *   `target`: what the user would type after `ssh` (an alias from
 *   ~/.ssh/config, or user@host).
 *   `runtimeVersion`: the host runtime installed there (in
 *   ~/.dream/host/versions/<version>/) and run; without one (tests,
 *   scripts), `dream-host` on the host's PATH.
 *   `runtimeCacheDirectory`: where this machine keeps archives it uploads
 *   to hosts that cannot download them.
 *   `controlPath`: a ControlMaster socket path to multiplex through; null
 *   where the client cannot (Windows).
 *   `env`: the ssh processes' environment (askpass variables included).
 */
export function createSshHostConnection({
  target,
  runtimeVersion = null,
  runtimeBaseUrl,
  runtimeCacheDirectory = null,
  interactive = true,
  sshPath = "ssh",
  controlPath = null,
  env = process.env,
  getLocalPort,
  onStatus = () => {},
  spawnProcess = spawnChildProcess,
  fetchImpl = (...args) => fetch(...args),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  now = () => Date.now(),
  isLocalPortOpen = (port) =>
    new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    }),
}) {
  /**
   * Ports of the host forwarded to this machine (a dev server, for the
   * browser panel) over this link: remote port -> { localPort, held,
   * active }. They end with the link; a stable local address is the
   * connection's relay, above the route.
   */
  const portForwards = new Map();
  let state = "idle";
  let endpoint = null;
  let session = null; // the ssh process whose exit means the link is gone
  let generation = 0; // bumps on disconnect, so a stale attempt stands down
  // The ssh processes of the attempt in flight, ended by cancel(); and the
  // error a cancelled attempt rejects with.
  let attemptProcesses = new Set();
  let cancellation = null; // { attempt, error }

  const setState = (next, extra = {}) => {
    state = next;
    onStatus({ state: next, target, ...extra });
  };

  const spawnTracked = (args, stdio) => {
    const child = spawnProcess(
      sshPath,
      interactive
        ? args
        : ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", ...args],
      {
        env,
        stdio,
        windowsHide: true,
      },
    );
    const processes = attemptProcesses;
    processes.add(child);
    const forget = () => processes.delete(child);
    child.once("exit", forget);
    child.once("error", forget);
    return child;
  };

  // A held-open session reads nothing from Dream; the pipe exists so it
  // ends when Dream does.
  const spawnSsh = (args, { holdOpen = false } = {}) =>
    spawnTracked(args, [holdOpen ? "pipe" : "ignore", "pipe", "pipe"]);

  // Managed: the runtime of this app's version, installed by Dream.
  const managed = Boolean(runtimeVersion);
  const hostCommand = managed
    ? managedHostCommand(runtimeVersion)
    : "dream-host";

  const runSsh = (args, { input = null } = {}) =>
    new Promise((resolve) => {
      const child = input
        ? spawnTracked(args, ["pipe", "pipe", "pipe"])
        : spawnSsh(args);
      if (input) {
        const source = createReadStream(input);
        source.on("error", () => child.stdin?.destroy());
        source.pipe(child.stdin);
      }
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", (error) =>
        resolve({ code: -1, stderr: error.message, stdout }),
      );
      child.once("close", (code) => resolve({ code, stderr, stdout }));
    });

  const sshFailure = (what, stderr) =>
    new SshHostError(`${what}: ${lastLine(stderr) || "ssh failed"}`, {
      detail: stderr,
      fatal: FATAL_SSH_ERRORS.test(stderr),
    });

  /** Starts a long-lived ssh process; resolves once `ready` says so. */
  const startHeldSession = (args, ready, timeoutMs) =>
    new Promise((resolve, reject) => {
      const child = spawnSsh(args, { holdOpen: true });
      let stderr = "";
      let settled = false;
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      const fail = (error) => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(error);
      };
      child.once("error", (error) => fail(new SshHostError(error.message)));
      child.once("exit", () =>
        fail(sshFailure("SSH connection closed", stderr)),
      );

      const deadline = now() + timeoutMs;
      const poll = async () => {
        if (settled) return;
        if (now() > deadline) {
          fail(new SshHostError("Timed out connecting over SSH."));
          return;
        }
        if (await ready()) {
          settled = true;
          resolve(child);
          return;
        }
        setTimer(poll, POLL_MS);
      };
      void poll();
    });

  /** Installs the managed runtime on the host if it is not there yet. */
  const installRuntime = async () => {
    const install = (uploaded = null) =>
      runSsh(
        buildScriptArgs({
          controlPath,
          script: buildInstallScript({
            baseUrl: runtimeBaseUrl,
            uploaded,
            version: runtimeVersion,
          }),
          target,
        }),
      );
    let result = await install();

    if (result.code === INSTALL_EXIT.download && runtimeCacheDirectory) {
      // The host could not download it: this machine does, and uploads it.
      const platform = parsePlatform(
        (
          await runSsh(
            buildScriptArgs({
              controlPath,
              script: buildPlatformScript(),
              target,
            }),
          )
        ).stdout,
      );
      if (platform) {
        const { archivePath, name, sumsPath } = await downloadRuntimeArchive({
          arch: platform.arch,
          baseUrl: runtimeBaseUrl,
          cacheDirectory: runtimeCacheDirectory,
          fetchImpl,
          os: platform.os,
          version: runtimeVersion,
        });
        const remotePath = `.dream/host/upload/${name}`;
        for (const [file, destination] of [
          [archivePath, remotePath],
          [sumsPath, `${remotePath}.sums`],
        ]) {
          const uploaded = await runSsh(
            buildUploadArgs({ controlPath, remotePath: destination, target }),
            { input: file },
          );
          if (uploaded.code !== 0) {
            throw sshFailure("Could not upload Dream's host", uploaded.stderr);
          }
        }
        result = await install(remotePath);
      }
    }

    if (result.code !== 0) {
      if (result.code === 255) throw sshFailure("SSH failed", result.stderr);
      throw new SshHostError(
        `Could not install Dream's host on ${target}: ${lastLine(result.stderr) || `exit ${result.code}`}`,
        {
          detail: result.stderr,
          fatal: [
            INSTALL_EXIT.broken,
            INSTALL_EXIT.checksum,
            INSTALL_EXIT.unsupported,
          ].includes(result.code),
        },
      );
    }
  };

  const runEnsure = async () => {
    const { code, stdout, stderr } = await runSsh(
      buildEnsureArgs({ controlPath, hostCommand, target }),
    );
    let result = null;
    try {
      result = JSON.parse(lastLine(stdout));
    } catch {
      // Reported below.
    }
    if (code !== 0 || !result || result.error) {
      if (!result && code !== 255) {
        throw new SshHostError(
          `Could not run "${hostCommand}" on ${target}: ${lastLine(stderr) || `exit ${code}`}`,
          { detail: stderr, fatal: true },
        );
      }
      throw result?.error
        ? new SshHostError(`The host could not start: ${result.error}`, {
            detail: stderr,
          })
        : sshFailure("SSH failed", stderr);
    }
    const problem = hostProtocolProblem(result.hostProtocolVersion);
    if (problem) throw new SshHostError(problem, { fatal: true });
    return result;
  };

  const fetchHostInfo = async (localPort, token) => {
    try {
      const response = await requestHostInfo({
        baseUrl: `http://127.0.0.1:${localPort}`,
        headers: { [API_SESSION_TOKEN_HEADER]: token },
        fetchImpl,
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };

  /** One attempt. Resolves with { endpoint, session } or rejects. */
  const establish = async () => {
    let master = null;
    try {
      if (controlPath) {
        master = await startHeldSession(
          buildMasterArgs({ controlPath, target }),
          async () =>
            (await runSsh(buildMasterCheckArgs({ controlPath, target })))
              .code === 0,
          MASTER_READY_TIMEOUT_MS,
        );
      }

      if (managed) await installRuntime();
      const daemon = await runEnsure();
      const localPort = await getLocalPort();
      const ports = { localPort, remotePort: daemon.port };
      let info = null;
      const answers = async () => {
        const answered = await fetchHostInfo(localPort, daemon.token);
        if (answered?.pid !== daemon.pid) return false;
        info = answered;
        return true;
      };

      let held = master;
      if (master) {
        const forwarded = await runSsh(
          buildMasterForwardArgs({ controlPath, target, ...ports }),
        );
        if (forwarded.code !== 0) {
          throw sshFailure(
            "Could not forward the host's port",
            forwarded.stderr,
          );
        }
        const deadline = now() + VERIFY_TIMEOUT_MS;
        while (!(await answers())) {
          if (now() > deadline || master.exitCode !== null) {
            throw new SshHostError("The host did not answer through SSH.");
          }
          await new Promise((resolve) => setTimer(resolve, POLL_MS));
        }
      } else {
        held = await startHeldSession(
          buildDirectForwardArgs({ target, ...ports }),
          answers,
          VERIFY_TIMEOUT_MS,
        );
      }

      const hostId = typeof info?.hostId === "string" ? info.hostId : null;
      const fingerprint =
        typeof info?.fingerprint === "string" ? info.fingerprint : null;

      return {
        endpoint: {
          baseUrl: `http://127.0.0.1:${localPort}`,
          fingerprint,
          hostId,
          hostProtocolVersion: daemon.hostProtocolVersion,
          pid: daemon.pid,
          token: daemon.token,
          version: daemon.version ?? null,
        },
        session: held,
      };
    } catch (error) {
      master?.kill();
      throw error;
    }
  };

  /** Opens one port forward over the current link. */
  const openPortForward = async (remotePort, localPort) => {
    if (controlPath) {
      // Through the master: it lives (and dies) with the link.
      const forwarded = await runSsh(
        buildMasterForwardArgs({ controlPath, localPort, remotePort, target }),
      );
      if (forwarded.code !== 0) {
        throw sshFailure(
          `Could not forward port ${remotePort}`,
          forwarded.stderr,
        );
      }
      return null;
    }
    // Without a master: an ssh that holds just this forward.
    return startHeldSession(
      buildDirectForwardArgs({ localPort, remotePort, target }),
      () => isLocalPortOpen(localPort),
      VERIFY_TIMEOUT_MS,
    );
  };

  // Forwards being opened, by remote port: concurrent callers (a page's
  // parallel connections) share one forward instead of each opening one.
  const openingForwards = new Map();

  const forwardPort = (remotePort) => {
    const existing = portForwards.get(remotePort);
    if (existing?.active) return Promise.resolve(existing.localPort);
    const opening = openingForwards.get(remotePort);
    if (opening) return opening;
    const next = (async () => {
      const localPort = await getLocalPort();
      const held = await openPortForward(remotePort, localPort);
      const entry = { active: true, held, localPort };
      portForwards.set(remotePort, entry);
      held?.once("exit", () => {
        entry.active = false;
      });
      return localPort;
    })().finally(() => {
      if (openingForwards.get(remotePort) === next)
        openingForwards.delete(remotePort);
    });
    openingForwards.set(remotePort, next);
    return next;
  };

  const closePortForwards = () => {
    for (const entry of portForwards.values()) {
      entry.active = false;
      entry.held?.kill();
    }
  };

  const adopt = (attempt, { endpoint: next, session: held }) => {
    if (attempt !== generation) {
      held.kill();
      return false;
    }
    endpoint = next;
    session = held;
    held.once("exit", () => {
      if (session !== held) return;
      session = null;
      endpoint = null;
      // Forwards through the master went with it; held ones end too.
      closePortForwards();
      portForwards.clear();
      openingForwards.clear();
      if (attempt !== generation) return;
      setState("disconnected", { error: "The SSH connection closed." });
    });
    setState("connected", { endpoint: next });
    return true;
  };

  return {
    getState: () => state,
    /** `{ baseUrl, token, ... }` while connected, else null. */
    getEndpoint: () => endpoint,

    /**
     * Forwards the host's `remotePort` (on its loopback) to this machine
     * over this link; resolves with the local port.
     * @param {number} remotePort
     */
    async forwardPort(remotePort) {
      if (state !== "connected") {
        throw new SshHostError("The host is not connected.");
      }
      return forwardPort(remotePort);
    },

    async connect() {
      if (state === "connecting" || state === "connected") {
        throw new SshHostError(`Already ${state}.`);
      }
      generation += 1;
      const attempt = generation;
      attemptProcesses = new Set();
      setState("connecting");
      try {
        const result = await establish();
        if (!adopt(attempt, result)) {
          throw new SshHostError("Disconnected while connecting.");
        }
        return endpoint;
      } catch (error) {
        if (cancellation?.attempt === attempt) throw cancellation.error;
        if (attempt === generation) {
          setState("failed", { error: error.message });
        }
        throw error;
      }
    },

    /**
     * Stops the attempt in flight: its ssh processes end and it fails with
     * `reason`. Without one, nothing.
     * @param {string} [reason]
     */
    cancel(reason = "Cancelled.") {
      if (state !== "connecting") return false;
      const error = new SshHostError(reason, { fatal: true, cancelled: true });
      cancellation = { attempt: generation, error };
      generation += 1;
      for (const child of attemptProcesses) child.kill();
      attemptProcesses = new Set();
      setState("failed", { error: reason });
      return true;
    },

    /** Ends the session. The daemon and its work keep running. */
    disconnect() {
      generation += 1;
      const held = session;
      session = null;
      endpoint = null;
      closePortForwards();
      portForwards.clear();
      openingForwards.clear();
      held?.kill();
      for (const child of attemptProcesses) child.kill();
      attemptProcesses = new Set();
      if (state !== "idle") setState("disconnected");
    },
  };
}
