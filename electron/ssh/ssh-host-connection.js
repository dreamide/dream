// One connection from this machine to the host daemon on an SSH host: run
// `dream-host ensure` there, forward a loopback port to the daemon, check
// it answers, and keep it that way.
//
//   connect()     first attempt; resolves with the endpoint or rejects with
//                 why (no automatic retry: the user is watching).
//   (dropped)     once connected, a lost session is re-established with
//                 capped, jittered backoff; ensure runs again, since the
//                 daemon may have restarted on a new port.
//   disconnect()  ends the session. The daemon is never stopped: its
//                 terminals and turns keep running for the next connect.
//
// An attempt that fails on authentication or the host key stops retrying:
// asking for a password again every minute helps nobody.
//
// Electron-free: the process spawner, port picker, fetch and timers are
// injected, so it runs under plain Node and in tests.
import { spawn as spawnChildProcess } from "node:child_process";
import { API_SESSION_TOKEN_HEADER } from "../api/shared/session-token.js";
import { SUPPORTED_HOST_PROTOCOLS } from "../host/protocol.js";
import {
  buildDirectForwardArgs,
  buildEnsureArgs,
  buildMasterArgs,
  buildMasterCheckArgs,
  buildMasterForwardArgs,
} from "./ssh-args.js";

const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000, 60_000];
const STABLE_AFTER_MS = 60_000;
const MASTER_READY_TIMEOUT_MS = 5 * 60_000;
const VERIFY_TIMEOUT_MS = 15_000;
const POLL_MS = 200;

const FATAL_SSH_ERRORS =
  /Permission denied|Host key verification failed|Too many authentication failures|REMOTE HOST IDENTIFICATION HAS CHANGED/i;

export class SshHostError extends Error {
  /**
   * @param {string} message
   * @param {{ fatal?: boolean, detail?: string }} [options]
   *   `fatal`: retrying cannot help (authentication, host key, protocol).
   */
  constructor(message, { fatal = false, detail = "" } = {}) {
    super(message);
    this.name = "SshHostError";
    this.fatal = fatal;
    this.detail = detail;
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
 *   hostCommand?: string,
 *   sshPath?: string,
 *   controlPath?: string | null,
 *   env?: Record<string, string | undefined>,
 *   getLocalPort: () => Promise<number>,
 *   onStatus?: (status: object) => void,
 *   spawnProcess?: typeof spawnChildProcess,
 *   fetchImpl?: typeof fetch,
 *   setTimer?: (callback: () => void, ms: number) => unknown,
 *   clearTimer?: (timer: unknown) => void,
 *   now?: () => number,
 *   random?: () => number,
 * }} options
 *   `target`: what the user would type after `ssh` (an alias from
 *   ~/.ssh/config, or user@host).
 *   `hostCommand`: how to run dream-host on the host.
 *   `controlPath`: a ControlMaster socket path to multiplex through; null
 *   where the client cannot (Windows).
 *   `env`: the ssh processes' environment (askpass variables included).
 */
export function createSshHostConnection({
  target,
  hostCommand = "dream-host",
  sshPath = "ssh",
  controlPath = null,
  env = process.env,
  getLocalPort,
  onStatus = () => {},
  spawnProcess = spawnChildProcess,
  fetchImpl = (...args) => fetch(...args),
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (timer) => clearTimeout(timer),
  now = () => Date.now(),
  random = Math.random,
}) {
  let state = "idle";
  let endpoint = null;
  let session = null; // the ssh process whose exit means the link is gone
  let retryTimer = null;
  let retryIndex = 0;
  let connectedAt = 0;
  let generation = 0; // bumps on disconnect, so a stale attempt stands down

  const setState = (next, extra = {}) => {
    state = next;
    onStatus({ state: next, target, ...extra });
  };

  const spawnSsh = (args, { holdOpen = false } = {}) =>
    spawnProcess(sshPath, args, {
      env,
      // A held-open session reads nothing from Dream; the pipe exists so it
      // ends when Dream does.
      stdio: [holdOpen ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });

  const runSsh = (args) =>
    new Promise((resolve) => {
      const child = spawnSsh(args);
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
    const version = result.hostProtocolVersion;
    if (
      !Number.isInteger(version) ||
      version < SUPPORTED_HOST_PROTOCOLS.min ||
      version > SUPPORTED_HOST_PROTOCOLS.max
    ) {
      throw new SshHostError(
        `The host speaks protocol ${version}; this app supports ${SUPPORTED_HOST_PROTOCOLS.min}-${SUPPORTED_HOST_PROTOCOLS.max}.`,
        { fatal: true },
      );
    }
    return result;
  };

  const fetchHostInfo = async (localPort, token) => {
    try {
      const response = await fetchImpl(
        `http://127.0.0.1:${localPort}/api/host-info`,
        {
          headers: { [API_SESSION_TOKEN_HEADER]: token },
          signal: AbortSignal.timeout(2_000),
        },
      );
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

      const daemon = await runEnsure();
      const localPort = await getLocalPort();
      const ports = { localPort, remotePort: daemon.port };
      const answers = async () =>
        (await fetchHostInfo(localPort, daemon.token))?.pid === daemon.pid;

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

      return {
        endpoint: {
          baseUrl: `http://127.0.0.1:${localPort}`,
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

  const adopt = (attempt, { endpoint: next, session: held }) => {
    if (attempt !== generation) {
      held.kill();
      return false;
    }
    endpoint = next;
    session = held;
    connectedAt = now();
    held.once("exit", () => {
      if (session !== held) return;
      session = null;
      endpoint = null;
      if (attempt !== generation) return;
      if (now() - connectedAt >= STABLE_AFTER_MS) retryIndex = 0;
      setState("reconnecting");
      scheduleRetry(attempt);
    });
    setState("connected", { endpoint: next });
    return true;
  };

  const scheduleRetry = (attempt) => {
    const base =
      RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryIndex += 1;
    const delay = Math.round(base * (0.8 + random() * 0.4));
    retryTimer = setTimer(async () => {
      retryTimer = null;
      if (attempt !== generation) return;
      try {
        adopt(attempt, await establish());
      } catch (error) {
        if (attempt !== generation) return;
        if (error instanceof SshHostError && error.fatal) {
          setState("failed", { error: error.message });
          return;
        }
        setState("reconnecting", { error: error.message });
        scheduleRetry(attempt);
      }
    }, delay);
  };

  return {
    getState: () => state,
    /** `{ baseUrl, token, ... }` while connected, else null. */
    getEndpoint: () => endpoint,

    async connect() {
      if (state === "connecting" || state === "connected") {
        throw new SshHostError(`Already ${state}.`);
      }
      generation += 1;
      const attempt = generation;
      retryIndex = 0;
      setState("connecting");
      try {
        const result = await establish();
        if (!adopt(attempt, result)) {
          throw new SshHostError("Disconnected while connecting.");
        }
        return endpoint;
      } catch (error) {
        if (attempt === generation) {
          setState("failed", { error: error.message });
        }
        throw error;
      }
    },

    /** Ends the session. The daemon and its work keep running. */
    disconnect() {
      generation += 1;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      const held = session;
      session = null;
      endpoint = null;
      held?.kill();
      if (state !== "idle") setState("disconnected");
    },
  };
}
