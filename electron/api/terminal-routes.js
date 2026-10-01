// Terminals over the host's API: JSON routes to start, stop and inspect
// sessions. Their output, status, input, resizes and acknowledgments travel
// on the host socket's terminal channel (terminals/terminal-stream.js).
import { handleJsonRoute } from "./shared/json-route.js";
import {
  terminalEmptyRequestSchema,
  terminalStartRequestSchema,
  terminalStopRequestSchema,
} from "./terminals/schemas.js";

/**
 * @param {import("hono").Hono} app
 * @param {{
 *   sessions: {
 *     startTerminal: (payload: object) => Promise<object>,
 *     stopTerminalSession: (sessionId: string) => Promise<void>,
 *     stopAllProcesses: () => Promise<void>,
 *     getTerminalOutputDiagnostics: () => object[],
 *   },
 *   detectShells: () => unknown,
 *   diagnosticsEnabled?: boolean,
 * }} terminals
 */
export function registerTerminalRoutes(app, terminals) {
  const { detectShells, diagnosticsEnabled = false, sessions } = terminals;

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
}
