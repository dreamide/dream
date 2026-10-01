// Terminals over the host's API: JSON routes to start, stop and inspect
// sessions, and one WebSocket (the terminal socket) that carries output and
// status to clients and input, resizes and acknowledgments back. See
// terminals/terminal-stream.js for the socket's messages.
import { handleJsonRoute } from "./shared/json-route.js";
import {
  terminalEmptyRequestSchema,
  terminalStartRequestSchema,
  terminalStopRequestSchema,
} from "./terminals/schemas.js";

export const TERMINAL_SOCKET_PATH = "/api/terminal-socket";

/**
 * @param {import("hono").Hono} app
 * @param {{
 *   sessions: {
 *     startTerminal: (payload: object) => Promise<object>,
 *     stopTerminalSession: (sessionId: string) => Promise<void>,
 *     stopAllProcesses: () => Promise<void>,
 *     getTerminalOutputDiagnostics: () => object[],
 *   },
 *   stream: { connect: (client: { send: (text: string) => void }) => { receive: (text: string) => void, close: () => void } },
 *   tickets: { issue: () => string, redeem: (ticket: unknown) => boolean },
 *   detectShells: () => unknown,
 *   diagnosticsEnabled?: boolean,
 *   upgradeWebSocket?: Function,
 * }} terminals
 *   `upgradeWebSocket` is the server's upgrade helper; without it the
 *   socket route is not registered (route tests have no server).
 */
export function registerTerminalRoutes(app, terminals) {
  const {
    detectShells,
    diagnosticsEnabled = false,
    sessions,
    stream,
    tickets,
    upgradeWebSocket,
  } = terminals;

  app.post("/api/terminal-shells", (c) =>
    handleJsonRoute(c, terminalEmptyRequestSchema, () => detectShells(), {
      missingBody: {},
    }),
  );

  app.post("/api/terminal-start", (c) =>
    handleJsonRoute(
      c,
      terminalStartRequestSchema,
      (payload) => sessions.startTerminal(payload),
      { errorMessage: "Unable to start terminal.", errorStatus: 500 },
    ),
  );

  app.post("/api/terminal-stop", (c) =>
    handleJsonRoute(c, terminalStopRequestSchema, async ({ sessionId }) => {
      await sessions.stopTerminalSession(sessionId);
      return true;
    }),
  );

  app.post("/api/terminal-stop-all", (c) =>
    handleJsonRoute(
      c,
      terminalEmptyRequestSchema,
      async () => {
        await sessions.stopAllProcesses();
        return true;
      },
      { missingBody: {} },
    ),
  );

  app.post("/api/terminal-diagnostics", (c) =>
    handleJsonRoute(
      c,
      terminalEmptyRequestSchema,
      () => (diagnosticsEnabled ? sessions.getTerminalOutputDiagnostics() : []),
      { missingBody: {} },
    ),
  );

  app.post("/api/terminal-socket-ticket", (c) =>
    handleJsonRoute(
      c,
      terminalEmptyRequestSchema,
      () => ({ ticket: tickets.issue() }),
      { missingBody: {} },
    ),
  );

  if (!upgradeWebSocket) return;

  // Not behind the /api/* token guard (a browser WebSocket cannot send the
  // header); a one-time ticket from the route above stands in for it.
  app.get(
    TERMINAL_SOCKET_PATH,
    (c, next) =>
      tickets.redeem(c.req.query("ticket"))
        ? next()
        : c.text("Unauthorized", 401),
    upgradeWebSocket(() => {
      let connection = null;
      return {
        onOpen: (_event, ws) => {
          connection = stream.connect({ send: (text) => ws.send(text) });
        },
        onMessage: (event, _ws) => {
          if (typeof event.data === "string") connection?.receive(event.data);
        },
        onClose: () => {
          connection?.close();
          connection = null;
        },
        onError: () => {
          connection?.close();
          connection = null;
        },
      };
    }),
  );
}
