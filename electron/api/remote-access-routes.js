// Remote access over the host's API (host/auth/host-auth.js has the
// contract): pairing a device, its session, and managing the devices.
//
// On the local listener the caller is this host's local operator (the
// launch token); there it mints pairings, answers code requests, lists and
// revokes devices. On the remote listener the caller is a paired device,
// limited by its scopes, and the pairing exchange itself is served there
// too (`remote: true`): the only routes a client may call without a
// session, none of which grants anything without a pairing secret.
//
// A web client's credential is an HttpOnly cookie it never sees; a native
// client (`clientKind: "native"`) receives its token in the body, for its
// OS secure storage.
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import {
  AuthError,
  LOCAL_PRINCIPAL,
  SESSION_IDLE_TTL_MS,
} from "../host/auth/host-auth.js";
import { SCOPES } from "../host/auth/scopes.js";
import { handleJsonRoute, RouteError } from "./shared/json-route.js";

/** The web client's session cookie: host-only, HTTPS-only, same-site only. */
export const SESSION_COOKIE = "__Host-dream-session";

const deviceFields = {
  clientKind: z.enum(["web", "native"]).default("web"),
  deviceName: z.string().max(200).optional(),
};

export const remotePairRequestSchema = z.object({
  ...deviceFields,
  pairing: z.string().min(1).max(200),
});
export const remotePairCodeRequestSchema = z.object({
  ...deviceFields,
  code: z.string().min(1).max(32),
});
export const remotePairClaimRequestSchema = z.object({
  claimId: z.string().min(1).max(100),
  claimSecret: z.string().min(1).max(200),
});
export const remotePairingCreateRequestSchema = z.object({
  deviceName: z.string().max(200).optional(),
  scopes: z.array(z.enum(SCOPES)).min(1).default(["view", "operate"]),
});
export const remoteClaimAnswerRequestSchema = z.object({
  approve: z.boolean(),
  claimId: z.string().min(1).max(100),
});
export const remoteSessionRevokeRequestSchema = z.object({
  sessionId: z.string().min(1).max(100),
});
const emptyRequestSchema = z.object({}).passthrough();

/** Runs `work`, answering an AuthError with its status. */
const authorized = async (work) => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AuthError)
      throw new RouteError(error.message, error.status);
    throw error;
  }
};

/** The session cookie's lifetime follows the session's idle expiry. */
const setSessionCookie = (c, token) =>
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    maxAge: Math.floor(SESSION_IDLE_TTL_MS / 1000),
    path: "/",
    sameSite: "Strict",
    secure: true,
  });

const clearSessionCookie = (c) =>
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: true });

/**
 * What a client is told about its new session: a web client gets the
 * cookie and only the session's description; a native one its token.
 */
const deliverSession = (c, clientKind, { session, token }) => {
  if (clientKind === "native") return { session, token };
  setSessionCookie(c, token);
  return { session };
};

/** The credential a request carries: a bearer token, else the cookie. */
export const readSessionCredential = (c) => {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) {
    return { credential: header.slice("Bearer ".length).trim(), via: "bearer" };
  }
  const cookie = getCookie(c, SESSION_COOKIE);
  return cookie ? { credential: cookie, via: "cookie" } : null;
};

export { clearSessionCookie };

/**
 * @param {import("hono").Hono} app
 * @param {{
 *   auth: ReturnType<typeof import("../host/auth/host-auth.js").createHostAuth>,
 *   describeHost: () => object,
 *   remote: boolean,
 *   pairingUrls?: (fragment: string) => string[],
 * }} options
 *   `remote`: serving the remote listener (adds the public pairing
 *   routes). `pairingUrls`: where a pairing link may be opened, for the
 *   fragment a new pairing has (the remote listener's public origins).
 */
export const remoteAccessEnableSchema = z.object({
  httpsPort: z.number().int().min(1).max(65_535).optional(),
  mode: z.enum(["tailscale", "cloudflare"]).optional(),
  // Ignored: the user runs cloudflared. A desktop sends false so a host
  // older than 2026-10-28 uses that connector instead of asking for a token.
  cloudflareManaged: z.boolean().optional(),
  origin: z.string().max(500).optional(),
  port: z.number().int().min(1).max(65_535).nullable().optional(),
});

export function registerRemoteAccessRoutes(
  app,
  {
    auth,
    describeHost,
    signHostProof = null,
    remote,
    pairingUrls = () => [],
    remoteAccess = null,
  },
) {
  const principalOf = (c) => c.get("principal") ?? LOCAL_PRINCIPAL;

  if (remote) {
    app.get("/api/remote/descriptor", (c) => c.json(describeHost()));

    app.post("/api/remote/proof", (c) =>
      handleJsonRoute(
        c,
        z.object({
          nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          audience: z.string().url().max(500),
        }),
        ({ nonce, audience }) => {
          if (!signHostProof)
            throw new RouteError(
              "Update the host to support native connections.",
              426,
            );
          if (!pairingUrls("").some((url) => new URL(url).origin === audience))
            throw new RouteError(
              "The proof audience is not this host's origin.",
              421,
            );
          return signHostProof({ nonce, audience, host: describeHost() });
        },
      ),
    );

    app.post("/api/remote/pair", (c) =>
      handleJsonRoute(c, remotePairRequestSchema, (data) =>
        authorized(async () =>
          deliverSession(
            c,
            data.clientKind,
            await auth.exchangePairing({
              clientKind: data.clientKind,
              deviceName: data.deviceName,
              pairingSecret: data.pairing,
            }),
          ),
        ),
      ),
    );

    app.post("/api/remote/pair/code", (c) =>
      handleJsonRoute(c, remotePairCodeRequestSchema, (data) =>
        authorized(() => auth.claimPairingCode(data)),
      ),
    );

    app.post("/api/remote/pair/claim", (c) =>
      handleJsonRoute(c, remotePairClaimRequestSchema, (data) =>
        authorized(() => {
          const result = auth.pollClaim(data);
          if (result.status !== "confirmed") return result;
          return {
            status: "confirmed",
            ...deliverSession(c, result.session.clientKind, result),
          };
        }),
      ),
    );
  }

  app.get("/api/remote/session", (c) => c.json(auth.describe(principalOf(c))));

  // Extends the session from now. The credential does not change, so open
  // sockets and streams carry on; a web client's cookie is extended too.
  app.post("/api/remote/session/renew", (c) =>
    handleJsonRoute(
      c,
      emptyRequestSchema,
      () =>
        authorized(async () => {
          const session = await auth.renew(principalOf(c));
          const carried = readSessionCredential(c);
          if (carried?.via === "cookie")
            setSessionCookie(c, carried.credential);
          return { session };
        }),
      { missingBody: {} },
    ),
  );

  // Signs this device out: its session ends here and everywhere it is open.
  app.post("/api/remote/session/end", (c) =>
    handleJsonRoute(
      c,
      emptyRequestSchema,
      () =>
        authorized(async () => {
          const principal = principalOf(c);
          if (principal.kind !== "session") {
            throw new AuthError("Only a device session can be ended.", 400);
          }
          clearSessionCookie(c);
          return { session: await auth.revoke(principal, principal.sessionId) };
        }),
      { missingBody: {} },
    ),
  );

  app.post("/api/remote/pairings", (c) =>
    handleJsonRoute(c, remotePairingCreateRequestSchema, (data) =>
      authorized(() => {
        const pairing = auth.createPairing(principalOf(c), data);
        return { ...pairing, urls: pairingUrls(pairing.fragment) };
      }),
    ),
  );

  app.post("/api/remote/claims", (c) =>
    handleJsonRoute(
      c,
      emptyRequestSchema,
      () => authorized(() => ({ claims: auth.listClaims(principalOf(c)) })),
      { missingBody: {} },
    ),
  );

  app.post("/api/remote/claims/answer", (c) =>
    handleJsonRoute(c, remoteClaimAnswerRequestSchema, (data) =>
      authorized(() => auth.answerClaim(principalOf(c), data)),
    ),
  );

  app.post("/api/remote/sessions", (c) =>
    handleJsonRoute(
      c,
      emptyRequestSchema,
      () =>
        authorized(async () => ({
          sessions: await auth.listSessions(principalOf(c)),
        })),
      { missingBody: {} },
    ),
  );

  app.post("/api/remote/sessions/revoke", (c) =>
    handleJsonRoute(c, remoteSessionRevokeRequestSchema, ({ sessionId }) =>
      authorized(async () => ({
        session: await auth.revoke(principalOf(c), sessionId),
      })),
    ),
  );

  // Whether and how paired devices reach this host (host/remote-access/).
  // A device with `manage` may read it; changing it is this machine's own
  // business, so only on the local listener, for its local operator: a
  // paired device never turns its own access on or off.
  if (!remoteAccess) return;
  app.post("/api/remote/access", (c) =>
    handleJsonRoute(c, emptyRequestSchema, () => remoteAccess.status(), {
      missingBody: {},
    }),
  );
  if (remote) return;
  app.post("/api/remote/access/enable", (c) =>
    handleJsonRoute(c, remoteAccessEnableSchema, (options) =>
      remoteAccess.enable(options),
    ),
  );
  app.post("/api/remote/access/disable", (c) =>
    handleJsonRoute(c, emptyRequestSchema, () => remoteAccess.disable(), {
      missingBody: {},
    }),
  );
  app.post("/api/remote/access/check", (c) =>
    handleJsonRoute(c, emptyRequestSchema, () => remoteAccess.refresh(), {
      missingBody: {},
    }),
  );
}
