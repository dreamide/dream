// The host socket over HTTP: a guarded JSON route that issues a one-time
// ticket, and the WebSocket upgrade that redeems it. A browser WebSocket
// cannot send the API token header, so the ticket stands in for it, and
// the socket path is exempt from the /api/* token guard (app.js).
// What travels on the socket: host-socket/host-socket.js.
import { z } from "zod";
import { handleJsonRoute } from "./shared/json-route.js";

export const HOST_SOCKET_PATH = "/api/host-socket";

export const hostSocketTicketRequestSchema = z.object({}).passthrough();

/**
 * @param {import("hono").Hono} app
 * @param {{
 *   socket: { connect: (client: { send: (text: string) => void }) => { receive: (text: string) => void, close: () => void } },
 *   tickets: { issue: () => string, redeem: (ticket: unknown) => boolean },
 *   upgradeWebSocket?: Function,
 * }} options
 *   `upgradeWebSocket` is the server's upgrade helper; without it only the
 *   ticket route is registered (route tests have no server).
 */
export function registerHostSocketRoutes(
  app,
  { socket, tickets, upgradeWebSocket },
) {
  app.post("/api/host-socket-ticket", (c) =>
    handleJsonRoute(
      c,
      hostSocketTicketRequestSchema,
      () => ({ ticket: tickets.issue() }),
      { missingBody: {} },
    ),
  );

  if (!upgradeWebSocket) return;

  app.get(
    HOST_SOCKET_PATH,
    (c, next) =>
      tickets.redeem(c.req.query("ticket"))
        ? next()
        : c.text("Unauthorized", 401),
    upgradeWebSocket(() => {
      let connection = null;
      const close = () => {
        connection?.close();
        connection = null;
      };
      return {
        onOpen: (_event, ws) => {
          connection = socket.connect({ send: (text) => ws.send(text) });
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
