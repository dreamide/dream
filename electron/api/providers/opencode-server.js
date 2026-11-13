// An OpenCode server for one unit of work: a chat turn (chat/opencode-stream.js),
// a one-shot prompt (generate-text.js) or a usage read (usage-limits.js).
// The only place Dream starts one, so starting, timing out and closing it,
// creating a session and deciding whether a saved one may be resumed are
// one implementation, behind one port: the SDK's `createOpencode`.
//
// A server is started on a free loopback port and closed exactly once,
// whichever way its work ends. Aborting the work's signal stops a server
// still starting and, through the SDK, kills one already running.
import { createOpencode } from "@opencode-ai/sdk";

/** How long a server may take to say it is listening. */
export const OPENCODE_SERVER_TIMEOUT_MS = 10_000;

/**
 * Starts a server. `close` stops it and is safe to call again.
 * @param {{ config?: object, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ client: any, close: () => void }>}
 */
export async function openOpenCodeServer({
  config,
  signal,
  timeoutMs = OPENCODE_SERVER_TIMEOUT_MS,
} = {}) {
  const opencode = await createOpencode({
    ...(config ? { config } : {}),
    hostname: "127.0.0.1",
    port: 0,
    signal,
    timeout: timeoutMs,
  });
  let closed = false;
  return {
    client: opencode.client,
    close: () => {
      if (closed) return;
      closed = true;
      opencode.server.close();
    },
  };
}

/**
 * Runs `work` with a server, closing it however `work` ends.
 * @template T
 * @param {{ config?: object, signal?: AbortSignal, timeoutMs?: number }} options
 * @param {(client: any) => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withOpenCodeServer(options, work) {
  const server = await openOpenCodeServer(options);
  try {
    return await work(server.client);
  } finally {
    server.close();
  }
}

/**
 * Creates a session for `agent` on `model` in `directory`.
 * @returns {Promise<string>} its id
 */
export async function createOpenCodeSession(
  client,
  { agent, directory, model: { modelID, providerID }, signal },
) {
  const result = await client.session.create({
    body: { agent, model: { id: modelID, providerID } },
    query: { directory },
    signal,
  });
  const sessionId = result.data?.id;
  if (!sessionId) {
    throw new Error("OpenCode did not return a session id.");
  }
  return sessionId;
}

/**
 * Whether the saved session `sessionId` may carry the next turn, and why
 * not. OpenCode keeps failed and interrupted messages, and a session ending
 * in one repeats the failure on every retry; so only a session whose last
 * message is a finished, error-free assistant answer (not one stopped for
 * tool calls) is resumed.
 * @returns {Promise<{ resumed: true } | { resumed: false, reason: string }>}
 */
export async function resumeOpenCodeSession(
  client,
  { directory, sessionId, signal },
) {
  const existing = await client.session.get({
    path: { id: sessionId },
    query: { directory },
    signal,
  });
  if (existing.data?.id !== sessionId) {
    return {
      reason: "OpenCode no longer has the saved session.",
      resumed: false,
    };
  }
  const latest = await client.session.messages({
    path: { id: sessionId },
    query: { directory, limit: 1 },
    signal,
  });
  const last = Array.isArray(latest.data) ? latest.data.at(-1)?.info : null;
  const healthy =
    last?.role === "assistant" &&
    !last.error &&
    typeof last.time?.completed === "number" &&
    Boolean(last.finish) &&
    last.finish !== "tool-calls";
  return healthy
    ? { resumed: true }
    : {
        reason: "OpenCode's saved session ended unfinished or with an error.",
        resumed: false,
      };
}
