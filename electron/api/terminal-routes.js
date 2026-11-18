// Terminals over the host's API: JSON routes to start, stop and inspect
// sessions. Their output, status, input, resizes and acknowledgments travel
// on the host socket's terminal channel (terminals/terminal-stream.js).

import { HOST_ROUTES } from "../shared/host-routes.js";
import { handleJsonRoute } from "./shared/json-route.js";
import { registerRoute } from "./shared/register-route.js";
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

  registerRoute(app, HOST_ROUTES.terminalShells, (c) =>
    handleJsonRoute(c, terminalEmptyRequestSchema, () => detectShells(), {
      missingBody: {},
    }),
  );

  registerRoute(app, HOST_ROUTES.terminalStart, (c) =>
    handleJsonRoute(
      c,
      terminalStartRequestSchema,
      (payload) => sessions.startTerminal(payload),
      { errorMessage: "Unable to start terminal.", errorStatus: 500 },
    ),
  );

  registerRoute(app, HOST_ROUTES.terminalStop, (c) =>
    handleJsonRoute(c, terminalStopRequestSchema, async ({ sessionId }) => {
      await sessions.stopTerminalSession(sessionId);
      return true;
    }),
  );

  registerRoute(app, HOST_ROUTES.terminalStopAll, (c) =>
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

  registerRoute(app, HOST_ROUTES.terminalDiagnostics, (c) =>
    handleJsonRoute(
      c,
      terminalEmptyRequestSchema,
      () => (diagnosticsEnabled ? sessions.getTerminalOutputDiagnostics() : []),
      { missingBody: {} },
    ),
  );
}
