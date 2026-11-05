// The host command line's remote-access commands: what a headless machine
// uses instead of the desktop's Remote access settings. Each talks to the
// running host daemon's local API with the launch token from its private
// run record (run-directory.js), so only this machine's user can run them.
//
//   remote [status]                  is remote access on, and where
//   remote on [--tailscale] [--https-port n]
//   remote on --cloudflare --origin https://...
//                                    reach it through the user's own
//                                    cloudflared (`--external` is accepted
//                                    and has no effect)
//   remote off                       stop serving paired devices
//   remote check                     check the setup again
//   pair [--scopes view,operate] [--name name]
//                                    a pairing code: entered with this
//                                    host's address on the other computer,
//                                    it pairs it at once
//   devices                          paired devices
//   revoke <sessionId>               end a device's access
//
// `--json` prints the host's answer as one JSON line instead.

import { API_SESSION_TOKEN_HEADER } from "../api/shared/session-token.js";

const SCOPES = new Set(["view", "operate", "manage"]);

/** The running daemon's local API, as a caller. */
const connect =
  (record) =>
  async (route, body = {}) => {
    const response = await fetch(`http://127.0.0.1:${record.port}${route}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        [API_SESSION_TOKEN_HEADER]: record.token,
      },
      method: "POST",
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      const reason = (await response.text().catch(() => "")).trim();
      throw new Error(reason || `The host answered ${response.status}.`);
    }
    return response.json();
  };

const describeAccess = (status) => {
  const lines = [];
  if (!status.enabled) {
    lines.push("Remote access is off.");
    if (status.mode === "cloudflare")
      lines.push(
        "Dream does not run cloudflared; stop your connector separately when needed.",
      );
    return lines;
  }
  const via =
    status.mode === "cloudflare"
      ? "Cloudflare Tunnel (your cloudflared)"
      : `Tailscale Serve (HTTPS port ${status.httpsPort})`;
  lines.push(`Remote access is on, through ${via}.`);
  lines.push(
    status.listening
      ? `Listening on 127.0.0.1:${status.port} (loopback only).`
      : "Not listening.",
  );
  if (status.ready) lines.push(`Ready at ${status.origin}`);
  if (status.mode === "cloudflare") {
    lines.push(
      `Cloudflare hostname: ${status.requestedOrigin ?? "not configured"}.`,
    );
    if (status.port)
      lines.push(`Cloudflare service URL: http://127.0.0.1:${status.port}`);
  }
  if (status.problem) {
    lines.push(`Not ready: ${status.problem.message}`);
    if (status.problem.url) lines.push(`  ${status.problem.url}`);
  }
  return lines;
};

/**
 * Runs one remote-access command against the daemon described by `record`
 * (or tells the user to start one). Resolves with the exit code.
 * @param {{
 *   name: string,
 *   args: string[],
 *   values: Record<string, any>,
 *   record: { port: number, token: string } | null,
 *   print: (line: string) => void,
 *   write: (value: unknown) => void,
 * }} options
 */
export async function runRemoteCommand({
  name,
  args,
  values,
  record,
  print,
  write,
}) {
  if (!record) {
    print(
      "No Dream host is running here. Start one with `dream-host ensure --idle-timeout 0`.",
    );
    return 3;
  }
  const call = connect(record);
  const json = Boolean(values.json);
  const show = (value, lines) => {
    if (json) write(value);
    else for (const line of lines) print(line);
  };

  switch (name) {
    case "remote": {
      const action = args[0] ?? "status";
      let status;
      if (action === "status") status = await call("/api/remote/access");
      else if (action === "check")
        status = await call("/api/remote/access/check");
      else if (action === "off")
        status = await call("/api/remote/access/disable");
      else if (action === "on") {
        if (
          (values.cloudflare && values.tailscale) ||
          (values.origin && !values.cloudflare)
        ) {
          print(
            "Choose --cloudflare or --tailscale; --origin applies only to --cloudflare.",
          );
          return 2;
        }
        const httpsPort =
          values["https-port"] === undefined
            ? undefined
            : Number(values["https-port"]);
        const port =
          values.port === undefined ? undefined : Number(values.port);
        status = await call("/api/remote/access/enable", {
          ...(values.cloudflare
            ? {
                mode: "cloudflare",
                ...(values.origin ? { origin: values.origin } : {}),
                // An older host would otherwise run a connector of its own.
                cloudflareManaged: false,
              }
            : {}),
          ...(values.tailscale ? { mode: "tailscale" } : {}),
          ...(Number.isInteger(httpsPort) ? { httpsPort } : {}),
          ...(Number.isInteger(port) ? { port } : {}),
        });
      } else {
        print(
          "Usage: dream-host remote [status|on|off|check] [--cloudflare --origin https://...] [--tailscale [--https-port n]] [--port n]",
        );
        return 2;
      }
      show(status, describeAccess(status));
      return action === "on" && !status.ready ? 1 : 0;
    }

    case "pair": {
      const scopes = String(values.scopes ?? "view,operate")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
      if (scopes.length === 0 || scopes.some((scope) => !SCOPES.has(scope))) {
        print("--scopes takes view, operate and manage, comma separated.");
        return 2;
      }
      const access = await call("/api/remote/access");
      const pairing = await call("/api/remote/pairings", {
        ...(values.name ? { deviceName: values.name } : {}),
        scopes,
      });
      // Only a verified public address is offered as where to pair.
      const address = access.ready ? access.origin : null;
      const lines = [`Pairing code: ${pairing.code}`];
      lines.push(
        address
          ? `Enter it with this host's address, ${address}, on the other computer.`
          : "Remote access is not ready, so the other computer cannot reach this host yet. Run `dream-host remote on` first.",
        `Grants ${scopes.join(", ")}; expires at ${pairing.expiresAt}; works once.`,
      );
      show({ ...pairing, address }, lines);
      return 0;
    }

    case "devices": {
      const { sessions } = await call("/api/remote/sessions");
      const live = sessions.filter((session) => !session.revokedAt);
      show(
        sessions,
        live.length === 0
          ? ["No device is paired."]
          : live.map(
              (session) =>
                `${session.id}  “${session.deviceName}”  ${session.clientKind}  ${session.scopes.join(",")}  last used ${session.lastUsedAt}`,
            ),
      );
      return 0;
    }

    case "revoke": {
      const sessionId = args[0];
      if (!sessionId) {
        print("Usage: dream-host revoke <sessionId>");
        return 2;
      }
      const { session } = await call("/api/remote/sessions/revoke", {
        sessionId,
      });
      show(session, [`Revoked “${session.deviceName}”.`]);
      return 0;
    }

    default:
      return 2;
  }
}

export const REMOTE_COMMANDS = Object.freeze([
  "remote",
  "pair",
  "devices",
  "revoke",
]);
