/**
 * Tracks which project each in-flight agent turn belongs to.
 *
 * Providers that talk to Dream's browser MCP endpoint over HTTP with a
 * per-session config (OpenCode, ACP) get a project-scoped URL. Codex cannot:
 * its app-server is one shared process whose MCP config is fixed at startup,
 * so it calls a project-agnostic URL and the endpoint resolves the project
 * from the Codex turn that is currently running.
 */

let nextTurnId = 1;
/** @type {Map<number, {projectId: string, provider: string, startedAt: number}>} */
const activeTurns = new Map();
let lastEndedTurn = null;

/**
 * Register a running turn. Returns a function that ends it; calling it more
 * than once is harmless.
 */
export const beginBrowserTurn = ({ projectId, provider }) => {
  if (typeof projectId !== "string" || projectId.length === 0) {
    return () => {};
  }
  const id = nextTurnId++;
  activeTurns.set(id, { projectId, provider, startedAt: Date.now() });
  return () => {
    const turn = activeTurns.get(id);
    if (!turn) {
      return;
    }
    activeTurns.delete(id);
    lastEndedTurn = { ...turn, endedAt: Date.now() };
  };
};

/**
 * The project for the most recently started active turn, optionally limited
 * to one provider. Falls back to the last ended turn so a tool call that
 * races with the end of its turn still lands on the right project.
 */
export const getActiveBrowserTurnProjectId = ({ provider } = {}) => {
  let best = null;
  for (const turn of activeTurns.values()) {
    if (provider && turn.provider !== provider) {
      continue;
    }
    if (!best || turn.startedAt >= best.startedAt) {
      best = turn;
    }
  }
  if (best) {
    return best.projectId;
  }
  if (lastEndedTurn && (!provider || lastEndedTurn.provider === provider)) {
    return lastEndedTurn.projectId;
  }
  return null;
};

/** Test helper. */
export const resetBrowserTurnsForTests = () => {
  activeTurns.clear();
  lastEndedTurn = null;
};
