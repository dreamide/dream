// @ts-check
/**
 * Browser tools for an Agent turn: the one place a turn is given Dream's
 * browser. chat-routes.js attaches once per turn, hands the result to the
 * Provider adapter and ends it when the turn settles; the adapter only uses
 * what it is given. The mechanism is the Provider's `browserTools`
 * capability (provider-capabilities.js):
 *
 * - in-process: an MCP server object bound to the project (Claude's SDK).
 * - project-url: the browser MCP endpoint with the project in its URL,
 *   appended to the turn's MCP servers (OpenCode, ACP).
 * - shared-url: the endpoint without a project, for an agent process whose
 *   MCP config is fixed when it starts (Codex's app server). The turn is
 *   registered here until it ends, and the endpoint asks
 *   `resolveSharedBrowserProject` which project a call is for.
 * - none: nothing.
 *
 * A shared-url call names its turn by the Provider session it carries:
 * Codex puts its thread id in an MCP `tools/call`'s `_meta`
 * (`with_mcp_tool_call_ids_meta` in codex-rs core/src/mcp_tool_call.rs;
 * browser-mcp-routes.js reads it), the same id its
 * adapter reports with `turn.session`. A call that names no reported session
 * (an older Codex, a Codex subagent's own thread, a call before the turn
 * reported its thread) still takes the guess this module keeps: the most
 * recently started shared-url turn, else the last one that ended, so a call
 * racing its turn's end lands on its project.
 */
import {
  appendBrowserMcpServer,
  createBrowserMcpServer,
} from "./browser-tools.js";

/** @typedef {import("../../shared/provider-capabilities.js").BrowserToolsMechanism} BrowserToolsMechanism */

/**
 * @typedef {object} BrowserAttachment
 * @property {unknown[]} mcpServers The turn's MCP servers, with the browser
 *   endpoint where the mechanism is a URL.
 * @property {unknown | null} inProcessServer The in-process MCP server, or
 *   null.
 * @property {(sessionId: string) => void} session Tells it a Provider
 *   session id the turn reported (`turn.session`).
 * @property {() => void} end Releases it; calling it again is harmless.
 */

/**
 * Shared-url turns running now, in the order they started.
 * @type {Map<number, { projectId: string, sessionIds: Set<string> }>}
 */
const sharedTurns = new Map();
let nextSharedTurnId = 1;
/** @type {{ projectId: string, sessionIds: Set<string> } | null} */
let lastEndedSharedTurn = null;

const noop = () => {};

/**
 * @param {string | null | undefined} projectId
 * @returns {{ end: () => void, session: (sessionId: string) => void }}
 */
const registerSharedTurn = (projectId) => {
  if (typeof projectId !== "string" || projectId.length === 0) {
    return { end: noop, session: noop };
  }
  const id = nextSharedTurnId++;
  const turn = { projectId, sessionIds: new Set() };
  sharedTurns.set(id, turn);
  return {
    end: () => {
      if (!sharedTurns.delete(id)) return;
      lastEndedSharedTurn = turn;
    },
    session: (sessionId) => {
      if (typeof sessionId === "string" && sessionId.length > 0) {
        turn.sessionIds.add(sessionId);
      }
    },
  };
};

/**
 * Gives one Agent turn the browser by `mechanism`. Call once per turn and
 * `end()` when the turn settles, however it ends.
 * @param {{
 *   mechanism: BrowserToolsMechanism,
 *   projectId?: string | null,
 *   mcpServers?: unknown[],
 * }} options
 * @returns {BrowserAttachment}
 */
export const attachBrowser = ({ mechanism, projectId, mcpServers = [] }) => {
  /** @type {BrowserAttachment} */
  const nothing = {
    end: noop,
    inProcessServer: null,
    mcpServers,
    session: noop,
  };
  switch (mechanism) {
    case "in-process":
      return {
        ...nothing,
        inProcessServer: createBrowserMcpServer({ projectId }),
      };
    case "project-url":
      return {
        ...nothing,
        mcpServers: appendBrowserMcpServer(mcpServers, {
          projectId,
          scope: "project",
        }),
      };
    case "shared-url":
      return {
        ...nothing,
        mcpServers: appendBrowserMcpServer(mcpServers, {
          projectId,
          scope: "shared",
        }),
        ...registerSharedTurn(projectId),
      };
    default:
      return nothing;
  }
};

/**
 * The project a call to the shared browser endpoint is for: the shared-url
 * turn that reported `sessionId`, running or the last to end; otherwise the
 * guess, the most recently started shared-url turn, else the last to end.
 * Null when no shared-url turn has run.
 * @param {{ sessionId?: string | null }} [call]
 * @returns {string | null}
 */
export const resolveSharedBrowserProject = ({ sessionId = null } = {}) => {
  let newest = null;
  for (const turn of sharedTurns.values()) {
    if (sessionId && turn.sessionIds.has(sessionId)) return turn.projectId;
    newest = turn;
  }
  if (sessionId && lastEndedSharedTurn?.sessionIds.has(sessionId)) {
    return lastEndedSharedTurn.projectId;
  }
  return (newest ?? lastEndedSharedTurn)?.projectId ?? null;
};

/** Test helper. */
export const resetSharedBrowserTurnsForTests = () => {
  sharedTurns.clear();
  lastEndedSharedTurn = null;
};
