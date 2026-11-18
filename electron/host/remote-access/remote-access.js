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
// An override (`--remote-port`, `--remote-origin`, `--trust-forwarded-host`
// or their environment variables, host/options.js) replaces the saved
// settings for the life of the process: the host serves paired devices on
// that port for the user's own reverse proxy, reports it as `mode: "proxy"`
// with where it came from, and refuses changes until it is started without
// it. The saved settings are kept untouched for that later start.
//
// A public address is reported ready only after a request through it
// reached this host (Cloudflare also verifies its signed host-key proof): no address that
// does not work is shown as one that does. The listener itself stays on
// loopback; reaching it still requires pairing.
//
// Each way in (Tailscale, Cloudflare, the override's reverse proxy) is one
// adapter below; one apply and one status builder serve all three. The
// status says what readers show, so the settings view, `dream-host remote`
// and the daemon's log derive nothing:
//   phase     off       not serving paired devices
//             checking  being set up or checked; nothing known yet
//             ready     a request through `address` reached this host
//             notReady  on, and not reachable: `problem` says why, or
//                       there is no address to check (an override
//                       without --remote-origin)
//   address   the verified origin when ready; else the one set up or saved
//   lockedBy  the start-up options that set it (Settings cannot change
//             it), or null. Separate from `phase`: an override is itself
//             ready or not.
// The fields before these stay for older desktops; a newer client reads an
// older host through electron/shared/remote-access-view.js.
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
import { HOST_ROUTES } from "../../shared/host-routes.js";
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
 *   override?: {
 *     port: number,
 *     origins: string[],
 *     trustForwardedHost: boolean,
 *     sources: Record<string, string>,
 *   } | null,
 * }} options
 *   `listen` / `close`: the host's remote listener (index.js).
 *   `override`: remote access set when the host started (see above);
 *   `sources` names the flag or variable of each part, for the UI.
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
  override = null,
}) {
  const file = settingsFile;
  let settings = readSettings(file);
  // Where Dream once kept a connector's token and runtime; nothing uses it.
  const retiredConnectorDirectory = `${settingsFile}.cloudflare`;
  let listening = null; // { port, origin }
  let origin = null; // the verified public origin
  let tried = null; // the public origin the last apply set up, verified or not
  let problem = null;
  let checkedAt = null;
  // Nothing is known until the first apply settles, nor while one runs.
  let checking = true;
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

  /** Starts the listener; a busy port is a problem the user can act on. */
  const listenOn = async ({ port, publicOrigins, trustForwardedHost }) => {
    try {
      const started = await listen({ port, publicOrigins, trustForwardedHost });
      listening = { origin: publicOrigins[0] ?? null, port: started.port };
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

  const stopListening = async () => {
    if (!listening) return;
    listening = null;
    origin = null;
    await close();
  };

  /** Starts (or restarts) the listener on the saved port for `publicOrigin`. */
  const listenSaved = async (publicOrigin, preferredPort) => {
    if (listening?.origin === publicOrigin && listening.port === settings.port)
      return listening.port;
    await stopListening();
    let port = settings.port;
    if (!port) {
      port = await pickPort(preferredPort);
      save({ port });
    }
    // Both saved fronts are reverse proxies on this machine that may name
    // the public host in X-Forwarded-Host.
    return listenOn({
      port,
      publicOrigins: [publicOrigin],
      trustForwardedHost: true,
    });
  };

  /** The status fields of a way in that the saved settings choose. */
  const savedFields = ({ requestedOrigin, configured }) => ({
    port: listening?.port ?? settings.port,
    requestedOrigin,
    // Whether the saved settings can be turned on as they are.
    configured,
    // `managed: false` keeps a desktop older than 2026-10-28 on its
    // user-run connector form instead of asking for a token. `origin` is the
    // saved address in any mode, so switching back need not retype it.
    cloudflare: {
      managed: false,
      defaultPort: CLOUDFLARE_PORT,
      origin: settings.origin,
    },
  });

  /**
   * The ways in. Each one supplies:
   *   mode               the status's `mode`
   *   candidate()        the public origin to set up, or null when there is
   *                      none to check; throws a problem when it cannot say
   *   prepare(candidate) serves paired devices there: the listener and any
   *                      front door Dream sets up; resolves with its port
   *   teardown()         removes what `prepare` set up besides the listener
   *   secure             verifying also needs the host key's signed proof
   *   unreachable(candidate, port)  { hint, url }: what to check when the
   *                      candidate did not answer
   *   monitored          a started route is checked again on a timer
   *   refuse?(origin)    why an enable request for it would save nothing
   *   fields()           its part of the status
   */
  const tailscaleWay = {
    mode: "tailscale",
    secure: false,
    monitored: false,
    // The device's name first: it is the origin the listener accepts.
    candidate: async () => {
      const device = await tailscale.device();
      return settings.httpsPort === 443
        ? `https://${device.dnsName}`
        : `https://${device.dnsName}:${settings.httpsPort}`;
    },
    prepare: async (candidate) => {
      const port = await listenSaved(candidate);
      const served = { httpsPort: settings.httpsPort, localPort: port };
      // A Serve entry Dream made for another port is Dream's to remove.
      if (
        settings.servedBy &&
        (settings.servedBy.httpsPort !== served.httpsPort ||
          settings.servedBy.localPort !== served.localPort)
      ) {
        await tailscale.disable(settings.servedBy).catch(() => false);
        save({ servedBy: null });
      }
      await tailscale.enable(served);
      save({ servedBy: served });
      return port;
    },
    teardown: async () => {
      if (!settings.servedBy) return;
      await tailscale.disable(settings.servedBy);
      save({ servedBy: null });
    },
    unreachable: () => ({
      hint: "Tailscale may still be provisioning the certificate; check again in a minute.",
      url: null,
    }),
    fields: () => savedFields({ requestedOrigin: null, configured: true }),
  };

  const cloudflareWay = {
    mode: "cloudflare",
    secure: true,
    monitored: true,
    refuse: (requested) =>
      !requested
        ? {
            code: "needs-origin",
            message:
              "The address must be an https:// origin, such as https://dream.example.com.",
          }
        : /(^|\.)trycloudflare\.com$/i.test(new URL(requested).hostname)
          ? {
              code: "quick-tunnel",
              message:
                "Use a persistent Cloudflare tunnel with a stable hostname. Quick Tunnels do not support chat streaming.",
            }
          : null,
    candidate: async () => {
      if (!settings.origin) {
        throw Object.assign(
          new Error("Enter the HTTPS address of your Cloudflare hostname."),
          { problemCode: "needs-origin" },
        );
      }
      return settings.origin;
    },
    prepare: (candidate) => listenSaved(candidate, CLOUDFLARE_PORT),
    // The user runs cloudflared; Dream sets up nothing besides the listener.
    teardown: async () => {},
    unreachable: (_candidate, port) => ({
      hint: `Check that cloudflared is running for this tunnel and that the hostname's Cloudflare service URL is http://127.0.0.1:${port}.`,
      url: "https://one.dash.cloudflare.com/",
    }),
    fields: () =>
      savedFields({
        requestedOrigin: settings.origin,
        configured: Boolean(settings.origin),
      }),
  };

  // The override's way in: the user's own reverse proxy, on its port.
  const proxyWay = override && {
    mode: "proxy",
    secure: false,
    monitored: false,
    candidate: async () => override.origins[0] ?? null,
    prepare: async () =>
      listening?.port ??
      listenOn({
        port: override.port,
        publicOrigins: override.origins,
        trustForwardedHost: override.trustForwardedHost,
      }),
    teardown: async () => {},
    unreachable: (candidate, port) => ({
      hint: `Check that your reverse proxy forwards ${candidate} to http://127.0.0.1:${port}.`,
      url: null,
    }),
    fields: () => ({
      port: listening?.port ?? override.port,
      requestedOrigin: override.origins[0] ?? null,
      configured: true,
      override: { sources: override.sources },
      cloudflare: { managed: false, defaultPort: CLOUDFLARE_PORT },
    }),
  };

  const SAVED_WAYS = { tailscale: tailscaleWay, cloudflare: cloudflareWay };

  /**
   * The way in that is in effect: whether it is on, the saved ways it
   * replaces (what Dream set up for those goes), and the start-up options
   * that lock it, if any.
   */
  const selected = () => {
    if (override) {
      const names = Object.values(override.sources);
      return {
        way: proxyWay,
        on: true,
        replaced: [],
        lockedBy: names.length ? names : ["--remote-port"],
      };
    }
    const way = SAVED_WAYS[settings.mode];
    return {
      way,
      on: settings.enabled,
      replaced: Object.values(SAVED_WAYS).filter((other) => other !== way),
      lockedBy: null,
    };
  };

  /**
   * What every reader shows. Desktops older than `phase` read the fields
   * before it; newer readers read `phase`, `address` and `lockedBy`.
   */
  const status = () => {
    const { way, on, lockedBy } = selected();
    const phase = !on
      ? "off"
      : origin
        ? "ready"
        : checking
          ? "checking"
          : "notReady";
    const fields = way.fields();
    return {
      checkedAt,
      enabled: on,
      httpsPort: settings.httpsPort,
      listening: listening !== null,
      mode: way.mode,
      // Only an address verified to reach this host.
      origin,
      ...fields,
      problem,
      ready: phase === "ready",
      phase,
      // Verified when ready; else the one set up, or the one saved.
      address: origin ?? tried ?? fields.requestedOrigin,
      lockedBy,
    };
  };

  /** Why a change is refused while start-up options set remote access. */
  const refuseLocked = (lockedBy) => {
    problem = {
      code: "overridden",
      message: `Remote access is set by ${lockedBy.join(", ")} when the host starts. Start the host without those options to change remote access here.`,
      params: { sources: override.sources },
      refused: true,
      url: null,
    };
    return status();
  };

  /** Verify reachability; a secure way must also prove the installation key. */
  const verify = async (candidate, secure) => {
    const verified = secure
      ? createVerifiedHttps({
          origin: candidate,
          expectedIdentity: hostIdentity(),
        })
      : null;
    try {
      const response = await (verified?.request ?? fetchImpl)(
        `${candidate}${HOST_ROUTES.remoteDescriptor.path}`,
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
      verified?.close();
    }
  };

  /** Whether `candidate` reaches this host, with what to check when not. */
  const check = async (way, candidate) => {
    checkedAt = now();
    const unreachable = await verify(candidate, way.secure);
    origin = unreachable ? null : candidate;
    if (!unreachable) {
      problem = null;
      return;
    }
    const port = listening?.port ?? settings.port;
    const { hint, url } = way.unreachable(candidate, port);
    problem = {
      code: "unreachable",
      message: `${unreachable} ${hint}`,
      url,
      params: { detail: unreachable, origin: candidate, port },
    };
  };

  const clearMonitor = () => {
    clearTimeout(monitor);
    monitor = null;
  };
  // Only a started route of a monitored way is watched: when applying
  // failed, its problem (a busy port, a missing address) stays until the
  // next change.
  const watching = () => {
    const { way, on } = selected();
    return (
      !closing && on && way.monitored && listening !== null && tried !== null
    );
  };
  const armMonitor = () => {
    clearMonitor();
    if (!watching()) return;
    monitor = setTimeout(() => {
      monitor = null;
      void serially(async () => {
        if (!watching()) return;
        await check(selected().way, tried);
        armMonitor();
      }).catch(() => {});
    }, monitorMs);
    monitor.unref?.();
  };

  /** Brings the way in that is in effect into effect, or stops listening. */
  const apply = async () => {
    clearMonitor();
    checkedAt = now();
    origin = null;
    tried = null;
    problem = null;
    checking = true;
    const { way, on, replaced } = selected();
    try {
      if (!on) {
        await stopListening();
      } else {
        const candidate = await way.candidate();
        tried = candidate;
        for (const other of replaced) await other.teardown();
        await way.prepare(candidate);
        if (candidate) await check(way, candidate);
      }
    } catch (error) {
      problem = asProblem(error);
    } finally {
      checking = false;
    }
    armMonitor();
    return status();
  };

  return {
    status,

    /** Applies the saved settings, or the override (at startup). */
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
        const { lockedBy } = selected();
        if (lockedBy) return refuseLocked(lockedBy);
        const mode = Object.hasOwn(SAVED_WAYS, options.mode ?? "")
          ? options.mode
          : settings.mode;
        const requestedOrigin =
          options.origin === undefined
            ? settings.origin
            : httpsOrigin(options.origin);
        const refusal = SAVED_WAYS[mode].refuse?.(requestedOrigin);
        if (refusal) {
          problem = { ...refusal, url: null, refused: true };
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
     * longer reach it) and what Dream set up for each way in (the Serve
     * entry it made) is removed. Local work, and paired devices' sessions,
     * are untouched.
     */
    disable: () =>
      serially(async () => {
        const { lockedBy } = selected();
        if (lockedBy) return refuseLocked(lockedBy);
        save({ enabled: false });
        clearMonitor();
        await stopListening();
        tried = null;
        problem = null;
        checking = false;
        checkedAt = now();
        try {
          for (const way of Object.values(SAVED_WAYS)) await way.teardown();
        } catch (error) {
          // The listener is already closed, so nothing is reachable; the
          // leftover entry is reported, and removed on the next attempt.
          problem = asProblem(error);
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
