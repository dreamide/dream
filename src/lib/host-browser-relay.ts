/**
 * This window's side of an SSH host's browser channel
 * (electron/api/host-socket/browser-relay.js). Agents on the host use the
 * browser tools; their browser is this window's. The window tells the host
 * which of its projects it has open (in its resume cursor, and again on
 * every change), runs each call the host sends on its own browser (through
 * the local API, where the browser bridge lives) and sends back the result.
 */
import type { HostSocketClient, HostSocketMessage } from "./host-socket";

export const BROWSER_CHANNEL = "browser";

export interface BrowserToolCall {
  projectId: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface HostBrowserRelayOptions {
  socket: Pick<HostSocketClient, "register" | "send">;
  /** The host's projects this window has open, by id. */
  getProjectIds: () => string[];
  /** Runs one tool on this window's browser; resolves with its result. */
  runTool: (call: BrowserToolCall) => Promise<unknown>;
  /** The message to send back when a call fails outright. */
  describeError?: (error: unknown) => string;
}

export interface HostBrowserRelay {
  /** Tells the host the open projects, if they changed since last told. */
  announce(): void;
  stop(): void;
}

const defaultDescribeError = (error: unknown) =>
  error instanceof Error && error.message
    ? error.message
    : "The browser tool failed.";

export const createHostBrowserRelay = ({
  socket,
  getProjectIds,
  runTool,
  describeError = defaultDescribeError,
}: HostBrowserRelayOptions): HostBrowserRelay => {
  // What the host was last told, so an unchanged list is not resent.
  let told: string | null = null;
  const keyOf = (ids: string[]) => [...ids].sort().join("\n");

  const reply = (message: Omit<HostSocketMessage, "channel">) =>
    socket.send({ channel: BROWSER_CHANNEL, ...message } as HostSocketMessage);

  const receive = (message: HostSocketMessage) => {
    if (message.type !== "call" || typeof message.id !== "string") return;
    const id = message.id;
    const projectId =
      typeof message.projectId === "string" ? message.projectId : "";
    const tool = typeof message.tool === "string" ? message.tool : "";
    const args =
      message.args && typeof message.args === "object"
        ? (message.args as Record<string, unknown>)
        : {};

    if (!getProjectIds().includes(projectId)) {
      reply({
        id,
        message: "This Dream window no longer has the project open.",
        type: "error",
      });
      return;
    }
    runTool({ args, projectId, tool }).then(
      (result) => reply({ id, result, type: "result" }),
      (error: unknown) =>
        reply({ id, message: describeError(error), type: "error" }),
    );
  };

  const unregister = socket.register({
    cursor: () => {
      const projectIds = getProjectIds();
      told = keyOf(projectIds);
      return { projectIds };
    },
    name: BROWSER_CHANNEL,
    receive,
  });

  return {
    announce() {
      const projectIds = getProjectIds();
      const key = keyOf(projectIds);
      if (key === told) return;
      told = key;
      reply({ projectIds, type: "projects" });
    },
    stop() {
      unregister();
    },
  };
};
