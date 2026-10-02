// The browser channel of the host socket: an agent on this host using the
// browser tools, whose browser is a window's (its tabs are `<webview>`s in
// whichever window has the project open). The host sends each tool call to
// that window, which runs it on its own browser and answers.
//
// A window says which of this host's projects it has open in its resume
// cursor (so a reconnect re-announces it) and again whenever that changes.
// A call goes to the window that announced the project most recently; with
// none, the tool answers that the browser is unavailable.
//
// Messages, all with `channel: "browser"`:
//   client -> host   projects {projectIds}
//                    result {id, result}
//                    error {id, message}
//   host -> client   call {id, projectId, tool, args}
// Its resume cursor: {projectIds} or null.

export const BROWSER_CHANNEL = "browser";

/** How long a window has to answer one tool call (page loads included). */
export const BROWSER_CALL_TIMEOUT_MS = 120_000;

/** No window has the project open: the tools say so instead of failing. */
export class BrowserUnavailableError extends Error {
  constructor(
    message = "No Dream window has this project open, so its browser is unavailable.",
  ) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

const asProjectIds = (value) =>
  Array.isArray(value)
    ? value.filter((id) => typeof id === "string" && id.length > 0)
    : [];

/**
 * @param {{ timeoutMs?: number, createId?: () => string }} [options]
 */
export function createBrowserRelay({
  timeoutMs = BROWSER_CALL_TIMEOUT_MS,
  createId = (() => {
    let next = 0;
    return () => `call-${++next}`;
  })(),
} = {}) {
  /**
   * The windows that announced projects, each with how to reach it.
   * @type {Map<object, { send: (message: object) => void, projectIds: Set<string>, announcedAt: number }>}
   */
  const windows = new Map();
  /** @type {Map<string, { resolve: Function, reject: Function, timer: any, client: object }>} */
  const pending = new Map();
  let announcements = 0;

  const announce = (client, send, projectIds) => {
    windows.set(client, {
      announcedAt: ++announcements,
      projectIds: new Set(asProjectIds(projectIds)),
      send,
    });
  };

  const settle = (id, settleWith) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    clearTimeout(call.timer);
    settleWith(call);
  };

  /** The window most recently announcing `projectId`, or null. */
  const windowFor = (projectId) => {
    let chosen = null;
    let chosenClient = null;
    for (const [client, window] of windows) {
      if (
        window.projectIds.has(projectId) &&
        (!chosen || window.announcedAt > chosen.announcedAt)
      ) {
        chosen = window;
        chosenClient = client;
      }
    }
    return chosen ? { client: chosenClient, window: chosen } : null;
  };

  return {
    /** A (re)connecting window's cursor carries what it has open. */
    resume(send, cursor, client) {
      if (!client) return;
      if (cursor && typeof cursor === "object") {
        announce(client, send, cursor.projectIds);
      } else {
        windows.delete(client);
      }
    },

    receive(message, send, client) {
      if (message.type === "projects") {
        if (client) announce(client, send, message.projectIds);
      } else if (message.type === "result" && typeof message.id === "string") {
        settle(message.id, (call) => call.resolve(message.result));
      } else if (message.type === "error" && typeof message.id === "string") {
        settle(message.id, (call) =>
          call.reject(
            new Error(
              typeof message.message === "string" && message.message
                ? message.message
                : "The browser tool failed in the window.",
            ),
          ),
        );
      }
    },

    /** A window went away: it answers nothing more. */
    close(client) {
      windows.delete(client);
      for (const [id, call] of pending) {
        if (call.client === client) {
          settle(id, (entry) =>
            entry.reject(
              new BrowserUnavailableError(
                "The Dream window running this browser tool went away.",
              ),
            ),
          );
        }
      }
    },

    /** Whether some window has `projectId` open. */
    has: (projectId) => windowFor(projectId) !== null,

    /**
     * Runs `tool` with `args` in the browser of the window that has
     * `projectId` open; resolves with the tool's result.
     */
    call(projectId, tool, args) {
      const target = windowFor(projectId);
      if (!target) {
        return Promise.reject(new BrowserUnavailableError());
      }
      const id = createId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            settle(id, (call) =>
              call.reject(
                new Error(`The browser tool ${tool} did not answer in time.`),
              ),
            ),
          timeoutMs,
        );
        pending.set(id, { client: target.client, reject, resolve, timer });
        try {
          target.window.send({
            args: args ?? {},
            channel: BROWSER_CHANNEL,
            id,
            projectId,
            tool,
            type: "call",
          });
        } catch (error) {
          settle(id, (call) => call.reject(error));
        }
      });
    },

    getWindowCount: () => windows.size,
  };
}
