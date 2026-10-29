// A host's remote access: whether paired devices can reach it, and how.
// The host owns it (not a client's workspace), so the desktop's local host
// and a daemon behave the same, and it is applied again when the host
// starts.
//
//   remote-access.json beside dream.db, or <database>.remote-access.json   0600
//     enabled      whether to serve paired devices at all
//     mode         "tailscale" or "cloudflare". A file saved with the
//                  removed "origin" mode (the user's own reverse proxy)
//                  loads as Tailscale with access off, so nothing is
//                  exposed again without the user choosing a route.
//     port         the listener's loopback port, picked once and kept so a
//                  tunnel's configuration stays valid across restarts
//     httpsPort    Tailscale's HTTPS port (443 by default)
//     origin       the Cloudflare hostname's public origin
//     servedBy     the Tailscale Serve entry Dream created, so turning
//                  access off removes exactly that and nothing else
//
// The user runs cloudflared for their tunnel; Dream never installs, starts
// or stops it. A file saved when Dream could run it may still say
// `cloudflareManaged`; that is ignored, and the private directory that held
// its token and runtime (<settings>.cloudflare) is removed at startup.
//
// A public address is reported ready only after a request through it
// reached this host (Cloudflare also verifies its signed host-key proof): no address that
// does not work is shown as one that does. The listener itself stays on
// loopback; reaching it still requires pairing.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import getPort from "get-port";
import { createVerifiedHttps } from "../../connections/https-route.js";
import { TailscaleProblem } from "./tailscale.js";

const SETTINGS_FILE = "remote-access.json";
/** The loopback port a Cloudflare route is set up with, when it is free. */
export const CLOUDFLARE_PORT = 5410;
const VERIFY_TIMEOUT_MS = 8_000;

const DEFAULTS = Object.freeze({
  enabled: false,
  httpsPort: 443,
  mode: "tailscale",
  origin: null,
  port: null,
  servedBy: null,
  version: 1,
});

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const validPort = (value) =>
  Number.isInteger(value) && value > 0 && value < 65_536 ? value : null;

/** An https origin (scheme, host, port only), or null. */
export const httpsOrigin = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
};

const readSettings = (file) => {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { ...DEFAULTS };
  }
  if (!isRecord(raw)) return { ...DEFAULTS };
  return {
    enabled: raw.enabled === true && raw.mode !== "origin",
    httpsPort: validPort(raw.httpsPort) ?? DEFAULTS.httpsPort,
    mode: raw.mode === "cloudflare" ? "cloudflare" : "tailscale",
    origin: httpsOrigin(raw.origin),
    port: validPort(raw.port),
    servedBy:
      isRecord(raw.servedBy) &&
      validPort(raw.servedBy.httpsPort) &&
      validPort(raw.servedBy.localPort)
        ? {
            httpsPort: raw.servedBy.httpsPort,
            localPort: raw.servedBy.localPort,
          }
        : null,
    version: 1,
  };
};

const writeSettings = (file, settings) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
};

/**
 * A problem the user can act on: { code, message, url, params?, refused? }.
 * `code` is the contract clients show their own words for, with `params`;
 * `message` is the English text for the command line and unknown codes.
 * `refused` marks an enable request that was refused and saved nothing.
 */
const asProblem = (error) =>
  error instanceof TailscaleProblem || error?.problemCode
    ? {
        code: error.problemCode ?? error.code,
        message: error.message,
        url: error.url ?? null,
        ...(error.params ? { params: error.params } : {}),
      }
    : {
        code: "failed",
        message: error instanceof Error ? error.message : String(error),
        url: null,
      };

/**
 * @param {{
 *   dataDirectory: string,
 *   settingsFile?: string,
 *   hostId: () => string,
 *   listen: (options: { port: number, publicOrigins: string[], trustForwardedHost: boolean }) => Promise<{ port: number, origins: string[] }>,
 *   close: () => Promise<void>,
 *   tailscale: ReturnType<typeof import("./tailscale.js").createTailscale>,
 *   hostIdentity?: () => { hostId: string, fingerprint?: string, publicKey?: string },
 *   fetchImpl?: typeof fetch,
 *   pickPort?: (preferred?: number) => Promise<number>,
 *   now?: () => string,
 *   monitorMs?: number,
 * }} options
 *   `listen` / `close`: the host's remote listener (index.js).
 */
export function createRemoteAccess({
  dataDirectory,
  settingsFile = path.join(dataDirectory, SETTINGS_FILE),
  hostId,
  listen,
  close,
  tailscale,
  hostIdentity = () => ({ hostId: hostId() }),
  fetchImpl = (...args) => fetch(...args),
  pickPort = (preferred) => getPort({ host: "127.0.0.1", port: preferred }),
  now = () => new Date().toISOString(),
  monitorMs = 10_000,
}) {
  const file = settingsFile;
  let settings = readSettings(file);
  // Where Dream once kept a connector's token and runtime; nothing uses it.
  const retiredConnectorDirectory = `${settingsFile}.cloudflare`;
  let listening = null; // { port }
  let origin = null; // the verified public origin
  let problem = null;
  let checkedAt = null;
  let monitor = null;
  let closing = false;
  // One change at a time: enable, disable and refresh never interleave.
  let queue = Promise.resolve();
  const serially = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const save = (patch) => {
    settings = { ...settings, ...patch };
    writeSettings(file, settings);
  };

  const status = () => ({
    checkedAt,
    enabled: settings.enabled,
    httpsPort: settings.httpsPort,
    listening: listening !== null,
    mode: settings.mode,
    // Only an address verified to reach this host.
    origin,
    port: listening?.port ?? settings.port,
    problem,
    ready: settings.enabled && listening !== null && origin !== null,
    requestedOrigin: settings.mode === "cloudflare" ? settings.origin : null,
    // Whether the saved settings can be turned on as they are.
    configured: settings.mode === "tailscale" || Boolean(settings.origin),
    // `managed: false` keeps a desktop older than 2026-10-28 on its
    // user-run connector form instead of asking for a token.
    cloudflare: { managed: false, defaultPort: CLOUDFLARE_PORT },
  });

  /** Verify reachability; Cloudflare must also prove the installation key. */
  const verify = async (candidate) => {
    const secure =
      settings.mode === "cloudflare"
        ? createVerifiedHttps({
            origin: candidate,
            expectedIdentity: hostIdentity(),
          })
        : null;
    try {
      const response = await (secure?.request ?? fetchImpl)(
        `${candidate}/api/remote/descriptor`,
        {
          redirect: "error",
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        return `${candidate} answered ${response.status}, not this host.`;
      }
      const descriptor = await response.json();
      return descriptor?.hostId === hostId()
        ? null
        : `${candidate} reaches a different Dream host.`;
    } catch (error) {
      return `${candidate} did not answer from this computer (${error instanceof Error ? error.message : error}).`;
    } finally {
      secure?.close();
    }
  };

  const stopListening = async () => {
    if (!listening) return;
    listening = null;
    await close();
  };

  /** Starts (or restarts) the listener for `publicOrigin`. */
  const startListening = async (publicOrigin) => {
    if (listening?.origin === publicOrigin && listening.port === settings.port)
      return listening.port;
    await stopListening();
    let port = settings.port;
    if (!port) {
      port = await pickPort(
        settings.mode === "cloudflare" ? CLOUDFLARE_PORT : undefined,
      );
      save({ port });
    }
    try {
      const started = await listen({
        port,
        publicOrigins: publicOrigin ? [publicOrigin] : [],
        // Both fronts are reverse proxies on this machine that may name the
        // public host in X-Forwarded-Host.
        trustForwardedHost: true,
      });
      listening = { port: started.port, origin: publicOrigin };
      return started.port;
    } catch (error) {
      if (error?.code === "EADDRINUSE") {
        throw Object.assign(
          new Error(
            `Port ${port} on this computer is already in use. Choose another port for remote access.`,
          ),
          { problemCode: "port-in-use", params: { port } },
        );
      }
      throw error;
    }
  };

  const checkCloudflare = async () => {
    checkedAt = now();
    const unreachable = await verify(settings.origin);
    origin = unreachable ? null : settings.origin;
    problem = unreachable
      ? {
          code: "unreachable",
          message: `${unreachable} Check that cloudflared is running for this tunnel and that the hostname's Cloudflare service URL is http://127.0.0.1:${listening?.port ?? settings.port}.`,
          url: "https://one.dash.cloudflare.com/",
          params: {
            detail: unreachable,
            origin: settings.origin,
            port: listening?.port ?? settings.port,
          },
        }
      : null;
  };
  const clearMonitor = () => {
    clearTimeout(monitor);
    monitor = null;
  };
  // Only a started Cloudflare route is watched: when applying failed, its
  // problem (a busy port, a missing address) stays until the next change.
  const watching = () =>
    !closing &&
    settings.enabled &&
    settings.mode === "cloudflare" &&
    listening !== null;
  const armMonitor = () => {
    clearMonitor();
    if (!watching()) return;
    monitor = setTimeout(() => {
      monitor = null;
      void serially(async () => {
        if (!watching()) return;
        await checkCloudflare();
        armMonitor();
      }).catch(() => {});
    }, monitorMs);
    monitor.unref?.();
  };

  /** Brings the saved settings into effect. */
  const apply = async () => {
    clearMonitor();
    checkedAt = now();
    origin = null;
    problem = null;
    if (!settings.enabled) {
      await stopListening();
      return status();
    }
    try {
      if (settings.mode === "cloudflare") {
        if (!settings.origin) {
          throw Object.assign(
            new Error("Enter the HTTPS address of your Cloudflare hostname."),
            { problemCode: "needs-origin" },
          );
        }
        // Tailscale is not the way in now: the Serve entry Dream made goes.
        if (settings.servedBy) {
          await tailscale.disable(settings.servedBy);
          save({ servedBy: null });
        }
        await startListening(settings.origin);
        await checkCloudflare();
        armMonitor();
        return status();
      }
      // Tailscale. The device's name first: it is the origin the listener
      // accepts.
      const device = await tailscale.device();
      const candidate =
        settings.httpsPort === 443
          ? `https://${device.dnsName}`
          : `https://${device.dnsName}:${settings.httpsPort}`;
      const port = await startListening(candidate);
      // A Serve entry Dream made for another port is Dream's to remove.
      if (
        settings.servedBy &&
        (settings.servedBy.httpsPort !== settings.httpsPort ||
          settings.servedBy.localPort !== port)
      ) {
        await tailscale.disable(settings.servedBy).catch(() => false);
        save({ servedBy: null });
      }
      await tailscale.enable({
        httpsPort: settings.httpsPort,
        localPort: port,
      });
      save({ servedBy: { httpsPort: settings.httpsPort, localPort: port } });
      const unreachable = await verify(candidate);
      if (unreachable) {
        problem = {
          code: "unreachable",
          message: `${unreachable} Tailscale may still be provisioning the certificate; check again in a minute.`,
          url: null,
          params: { detail: unreachable, origin: candidate, port },
        };
      } else {
        origin = candidate;
      }
    } catch (error) {
      problem = asProblem(error);
    }
    armMonitor();
    return status();
  };

  return {
    status,

    /** Applies the saved settings (at startup). */
    start: () =>
      serially(() => {
        closing = false;
        // A saved tunnel token is a secret nothing reads any more.
        try {
          rmSync(retiredConnectorDirectory, { force: true, recursive: true });
        } catch {
          // A file still held open (Windows) goes on a later start.
        }
        return apply();
      }),

    /** Checks again (after the user fixed a setup step). */
    refresh: () => serially(apply),

    /**
     * Turns remote access on with these settings.
     * @param {{ mode?: "tailscale" | "cloudflare", origin?: string, httpsPort?: number, port?: number | null }} options
     */
    enable: (options = {}) =>
      serially(async () => {
        const mode = ["tailscale", "cloudflare"].includes(options.mode)
          ? options.mode
          : settings.mode;
        const requestedOrigin =
          options.origin === undefined
            ? settings.origin
            : httpsOrigin(options.origin);
        if (
          mode === "cloudflare" &&
          (!requestedOrigin ||
            /(^|\.)trycloudflare\.com$/i.test(
              new URL(requestedOrigin).hostname,
            ))
        ) {
          problem = requestedOrigin
            ? {
                code: "quick-tunnel",
                message:
                  "Use a persistent Cloudflare tunnel with a stable hostname. Quick Tunnels do not support chat streaming.",
                url: null,
                refused: true,
              }
            : {
                code: "needs-origin",
                message:
                  "The address must be an https:// origin, such as https://dream.example.com.",
                url: null,
                refused: true,
              };
          return status();
        }
        closing = false;
        save({
          enabled: true,
          httpsPort: validPort(options.httpsPort) ?? settings.httpsPort,
          mode,
          origin: requestedOrigin,
          port:
            options.port === null
              ? null
              : (validPort(options.port) ?? settings.port),
        });
        return apply();
      }),

    /**
     * Turns remote access off: the listener stops (paired devices can no
     * longer reach it) and the Serve entry Dream made is removed. Local
     * work, and paired devices' sessions, are untouched.
     */
    disable: () =>
      serially(async () => {
        save({ enabled: false });
        clearMonitor();
        await stopListening();
        origin = null;
        problem = null;
        checkedAt = now();
        if (settings.servedBy) {
          try {
            await tailscale.disable(settings.servedBy);
            save({ servedBy: null });
          } catch (error) {
            // The listener is already closed, so nothing is reachable; the
            // leftover entry is reported, and removed on the next attempt.
            problem = asProblem(error);
          }
        }
        return status();
      }),

    /** Stops listening (the host is closing); settings stay as they are. */
    close: () => {
      closing = true;
      clearMonitor();
      return serially(stopListening);
    },
  };
}
