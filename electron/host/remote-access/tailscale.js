// Tailscale Serve, as the remote listener's HTTPS front door. Tailscale
// terminates HTTPS with the tailnet's certificate and forwards to the
// listener on loopback; the listener still requires pairing from every
// device, tailnet peer or not.
//
// Only the `tailscale` command line is used, and only these:
//   tailscale status --json           installed, signed in, name, HTTPS
//   tailscale serve status --json     what this device already serves
//   tailscale serve --bg --yes --https=<port> http://127.0.0.1:<local>
//   tailscale serve --https=<port> off
//
// Dream never runs `serve reset` and never turns off a port it does not
// own: a port serving anything other than Dream's listener is left alone
// and reported as taken. The JSON shapes are not documented as a stable
// contract, so they are read defensively; anything unrecognised is a
// problem reported to the user, never a guess.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Where the CLI lives when it is not on PATH. */
const KNOWN_LOCATIONS = {
  darwin: ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
  win32: [
    path.join(
      process.env.ProgramFiles ?? "C:\\Program Files",
      "Tailscale",
      "tailscale.exe",
    ),
  ],
};

/** The tailscale CLI to run: on PATH, or where its installer puts it. */
export const findTailscaleCli = (platform = process.platform) =>
  (KNOWN_LOCATIONS[platform] ?? []).find((candidate) =>
    existsSync(candidate),
  ) ?? "tailscale";

/**
 * Runs the CLI; resolves with { code, stdout, stderr } (never rejects for a
 * non-zero exit). A CLI that cannot be started resolves with code null.
 */
export const runTailscaleCli = (cli, args, { timeoutMs = 20_000 } = {}) =>
  new Promise((resolve) => {
    execFile(
      cli,
      args,
      {
        // macOS bundles the GUI and CLI in one executable. A desktop or
        // service has no terminal environment to select CLI mode reliably.
        ...(process.platform === "darwin"
          ? { env: { ...process.env, TAILSCALE_BE_CLI: "1" } }
          : {}),
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && (error.code === "ENOENT" || error.code === "EACCES")) {
          resolve({ code: null, stderr: String(error.message), stdout: "" });
          return;
        }
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stderr: String(stderr ?? ""),
          stdout: String(stdout ?? ""),
        });
      },
    );
  });

/**
 * A setup problem, with what the user can do about it. `code` is the
 * contract (clients show their own words for it); `message` is the English
 * text for the command line and for codes a client does not know; `params`
 * are the values a client's words need.
 */
export class TailscaleProblem extends Error {
  /**
   * @param {"not-installed" | "not-running" | "needs-login" | "needs-approval" | "https-disabled" | "port-taken" | "permission" | "failed"} code
   * @param {string} message
   * @param {{ url?: string | null, detail?: string, params?: Record<string, string | number> }} [options]
   */
  constructor(code, message, { url = null, detail = "", params } = {}) {
    super(message);
    this.name = "TailscaleProblem";
    this.code = code;
    this.url = url;
    this.detail = detail;
    this.params = params;
  }
}

const firstUrl = (text) => text.match(/https:\/\/\S+/)?.[0] ?? null;
const lastLine = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? "";

/** A failed CLI run, as the problem it most likely is. */
const problemFrom = ({ code, stderr, stdout }, fallback) => {
  const text = `${stderr}\n${stdout}`;
  if (code === null) {
    return new TailscaleProblem(
      "not-installed",
      "Tailscale is not installed on this computer.",
      { url: "https://tailscale.com/download" },
    );
  }
  if (
    /failed to connect to local tailscaled|is tailscaled running|connection refused/i.test(
      text,
    )
  ) {
    return new TailscaleProblem(
      "not-running",
      "Tailscale is installed but not running. Start it, then try again.",
      { detail: text },
    );
  }
  if (/access denied|permission denied|requires root|operator/i.test(text)) {
    return new TailscaleProblem(
      "permission",
      "Tailscale refused to change its serve settings for this user. On Linux, run `sudo tailscale set --operator=$USER` once, then try again.",
      { detail: text },
    );
  }
  if (
    /serve is not enabled|https.*not enabled|enable https|certificates? (are|is) not enabled/i.test(
      text,
    )
  ) {
    return new TailscaleProblem(
      "https-disabled",
      "HTTPS certificates are not enabled for your tailnet. Enable HTTPS (and Serve, if asked) in the Tailscale admin console, then try again.",
      {
        detail: text,
        url: firstUrl(text) ?? "https://login.tailscale.com/admin/dns",
      },
    );
  }
  return new TailscaleProblem(
    "failed",
    `${fallback}: ${lastLine(text) || `exit ${code}`}`,
    { detail: text },
  );
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * @param {{ run?: (args: string[]) => Promise<{ code: number | null, stdout: string, stderr: string }> }} [options]
 *   `run`: runs the CLI with `args` (injected in tests; the real CLI otherwise).
 */
export function createTailscale({
  run = (args) => runTailscaleCli(findTailscaleCli(), args),
} = {}) {
  /**
   * This device on its tailnet: { dnsName, httpsAvailable }. Throws a
   * TailscaleProblem when Tailscale cannot serve (missing, stopped, signed
   * out).
   */
  const device = async () => {
    const result = await run(["status", "--json"]);
    const status = parseJson(result.stdout);
    if (result.code === null) throw problemFrom(result, "Tailscale");
    if (!isRecord(status))
      throw problemFrom(result, "Could not read Tailscale's status");
    const state = status.BackendState;
    if (state === "NeedsLogin" || state === "NeedsMachineAuth") {
      throw new TailscaleProblem(
        state === "NeedsLogin" ? "needs-login" : "needs-approval",
        state === "NeedsLogin"
          ? "Sign in to Tailscale on this computer, then try again."
          : "This computer is waiting for approval in the Tailscale admin console.",
        {
          url:
            typeof status.AuthURL === "string" && status.AuthURL
              ? status.AuthURL
              : null,
        },
      );
    }
    if (state !== "Running") {
      throw new TailscaleProblem(
        "not-running",
        `Tailscale is not connected (${state ?? "unknown state"}). Connect it, then try again.`,
      );
    }
    const dnsName =
      typeof status.Self?.DNSName === "string"
        ? status.Self.DNSName.replace(/\.$/, "")
        : "";
    if (!dnsName) {
      throw new TailscaleProblem(
        "https-disabled",
        "This computer has no MagicDNS name. Enable MagicDNS and HTTPS certificates in the Tailscale admin console, then try again.",
        { url: "https://login.tailscale.com/admin/dns" },
      );
    }
    const certDomains = Array.isArray(status.CertDomains)
      ? status.CertDomains
      : [];
    return {
      dnsName,
      // Listed once HTTPS certificates are enabled for the tailnet.
      httpsAvailable: certDomains.length > 0,
    };
  };

  /**
   * What this device serves on `httpsPort`: null (nothing), `{ ours: true }`
   * when it is a proxy to `localPort` on loopback, else what it is.
   */
  const servedOn = async ({ dnsName, httpsPort, localPort }) => {
    const result = await run(["serve", "status", "--json"]);
    if (result.code !== 0)
      throw problemFrom(result, "Could not read Tailscale's serve settings");
    const config = parseJson(result.stdout.trim() || "{}");
    if (!isRecord(config))
      throw problemFrom(result, "Could not read Tailscale's serve settings");
    const port = String(httpsPort);
    const web = isRecord(config.Web) ? config.Web : {};
    const site = Object.entries(web).find(
      ([hostPort]) =>
        hostPort === `${dnsName}:${port}` || hostPort.endsWith(`:${port}`),
    )?.[1];
    const tcp = isRecord(config.TCP) ? config.TCP[port] : undefined;
    if (!site && !tcp) return null;
    const handlers = isRecord(site?.Handlers) ? site.Handlers : {};
    const proxies = Object.entries(handlers).map(([mount, handler]) => ({
      mount,
      target:
        isRecord(handler) && typeof handler.Proxy === "string"
          ? handler.Proxy
          : null,
    }));
    const ours =
      proxies.length === 1 &&
      proxies[0].mount === "/" &&
      /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)\/?$/.test(
        proxies[0].target ?? "",
      ) &&
      Number(proxies[0].target.match(/:(\d+)\/?$/)?.[1]) === localPort;
    return {
      ours,
      description: proxies.length
        ? proxies
            .map(
              (proxy) => `${proxy.mount} → ${proxy.target ?? "(not a proxy)"}`,
            )
            .join(", ")
        : "a TCP forward",
    };
  };

  return {
    device,
    servedOn,

    /**
     * Serves `https://<device>:<httpsPort>` from the listener on loopback
     * `localPort`. Refuses a port that already serves something else.
     * Resolves with the public origin.
     */
    async enable({ httpsPort, localPort }) {
      const { dnsName, httpsAvailable } = await device();
      if (!httpsAvailable) {
        throw new TailscaleProblem(
          "https-disabled",
          "HTTPS certificates are not enabled for your tailnet. Enable them in the Tailscale admin console (DNS page), then try again.",
          { url: "https://login.tailscale.com/admin/dns" },
        );
      }
      const existing = await servedOn({ dnsName, httpsPort, localPort });
      if (existing && !existing.ours) {
        throw new TailscaleProblem(
          "port-taken",
          `Tailscale already serves something else on HTTPS port ${httpsPort} (${existing.description}). Choose another port; Dream does not change it.`,
          { params: { port: httpsPort } },
        );
      }
      if (!existing) {
        const result = await run([
          "serve",
          "--bg",
          "--yes",
          `--https=${httpsPort}`,
          `http://127.0.0.1:${localPort}`,
        ]);
        if (result.code !== 0)
          throw problemFrom(result, "Tailscale could not start serving");
      }
      return httpsPort === 443
        ? `https://${dnsName}`
        : `https://${dnsName}:${httpsPort}`;
    },

    /**
     * Stops serving `httpsPort`, only when what it serves is Dream's
     * listener on `localPort`. Resolves with whether anything was removed.
     */
    async disable({ httpsPort, localPort }) {
      const { dnsName } = await device();
      const existing = await servedOn({ dnsName, httpsPort, localPort });
      if (!existing?.ours) return false;
      const result = await run(["serve", `--https=${httpsPort}`, "off"]);
      if (result.code !== 0)
        throw problemFrom(result, "Tailscale could not stop serving");
      return true;
    },
  };
}
