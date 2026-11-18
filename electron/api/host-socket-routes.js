// The host socket over HTTP: a guarded JSON route that issues a one-time
// ticket, and the WebSocket upgrade that redeems it. A browser WebSocket
// cannot send the API token header, so the ticket stands in for it, and
// the socket path is exempt from the /api/* token guard (app.js).
// What travels on the socket: host-socket/host-socket.js.
//
// A ticket is bound to whoever asked for it (the request's `principal`,
// set by the listener's guard): a paired device's socket may send only what
// its scopes allow, is refused if its session ended before the ticket was
// redeemed, and closes when the session is revoked.
import { z } from "zod";
import { LOCAL_PRINCIPAL } from "../host/auth/host-auth.js";
import { allowsSocketMessage } from "../host/auth/route-policy.js";
import { HOST_ROUTES } from "../shared/host-routes.js";
import { handleJsonRoute } from "./shared/json-route.js";
import { registerRoute } from "./shared/register-route.js";

export const HOST_SOCKET_PATH = HOST_ROUTES.hostSocket.path;

export const hostSocketTicketRequestSchema = z.object({}).passthrough();

/**
 * @param {import("hono").Hono} app
 * @param {{
 *   socket: { connect: (client: { send: (text: string) => void }, options?: { allows?: (channel: string, message: object) => boolean }) => { receive: (text: string) => void, close: () => void } },
 *   tickets: { issue: (principal: object) => string, redeem: (ticket: unknown) => any },
 *   auth?: { isActive: (principal: any) => boolean, track: (principal: any, close: () => void) => () => void } | null,
 *   upgradeWebSocket?: Function,
 * }} options
 *   `upgradeWebSocket` is the server's upgrade helper; without it only the
 *   ticket route is registered (route tests have no server). `auth`: the
 *   host's device sessions (host/auth/host-auth.js); without it every
 *   socket is the local operator's.
 */
export function registerHostSocketRoutes(
  app,
  { socket, tickets, auth = null, upgradeWebSocket },
) {
  registerRoute(app, HOST_ROUTES.hostSocketTicket, (c) =>
    handleJsonRoute(
      c,
      hostSocketTicketRequestSchema,
      () => ({ ticket: tickets.issue(c.get("principal") ?? LOCAL_PRINCIPAL) }),
      { missingBody: {} },
    ),
  );

  if (!upgradeWebSocket) return;

  registerRoute(
    app,
    HOST_ROUTES.hostSocket,
    (c, next) => {
      const principal = tickets.redeem(c.req.query("ticket"));
      if (!principal || (auth && !auth.isActive(principal))) {
        return c.text("Unauthorized", 401);
      }
      c.set("socketPrincipal", principal);
      return next();
    },
    upgradeWebSocket((c) => {
      const principal = c.get("socketPrincipal");
      let connection = null;
      let untrack = () => {};
      const close = () => {
        untrack();
        connection?.close();
        connection = null;
      };
      return {
        onOpen: (_event, ws) => {
          connection = socket.connect(
            { send: (text) => ws.send(text) },
            principal.kind === "local"
              ? {}
              : {
                  allows: (channel, message) =>
                    allowsSocketMessage(principal.scopes, channel, message),
                },
          );
          // Revoking the session closes the socket (4401: unauthorized).
          untrack =
            auth?.track(principal, () => ws.close(4401, "Revoked")) ?? untrack;
        },
        onMessage: (event) => {
          if (typeof event.data === "string") connection?.receive(event.data);
        },
        onClose: close,
        onError: close,
      };
    }),
  );
}
