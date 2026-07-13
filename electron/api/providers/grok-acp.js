import { spawn } from "node:child_process";
import readline from "node:readline";
import { resolveCliCommandPath } from "../shared/cli.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 64_000;

const getGrokPermissionMode = ({ agentMode, codexPermissionMode }) => {
  if (codexPermissionMode === "full-access") return "bypassPermissions";
  if (agentMode === "plan") return "plan";
  if (codexPermissionMode === "auto-accept-edits") return "acceptEdits";
  return "default";
};

const createGrokArgs = ({
  agentMode = "build",
  codexPermissionMode = "default",
  model,
  reasoningEffort,
} = {}) => {
  const args = [
    "--no-auto-update",
    "--permission-mode",
    getGrokPermissionMode({ agentMode, codexPermissionMode }),
    "agent",
    "--no-leader",
  ];

  if (model) args.push("--model", model);
  if (reasoningEffort) args.push("--reasoning-effort", reasoningEffort);
  args.push("stdio");
  return args;
};

export class GrokAcpConnection {
  constructor(child) {
    this.child = child;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.onNotification = null;
    this.onRequest = null;
    this.reader = readline.createInterface({ input: child.stdout });

    this.reader.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(
        -MAX_STDERR_CHARS,
      );
    });
    child.on("error", (error) => this.failPending(error));
    child.on("close", (code) => {
      this.closed = true;
      this.reader.close();
      const detail = this.stderr.trim();
      this.failPending(
        new Error(
          detail ||
            (code === 0
              ? "Grok ACP connection closed."
              : `Grok CLI exited with code ${code}.`),
        ),
      );
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new Error(
            message.error.message ||
              message.error.data?.message ||
              JSON.stringify(message.error),
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      void this.handleIncomingRequest(message);
      return;
    }

    if (message.method) {
      this.onNotification?.(message.method, message.params ?? {});
    }
  }

  async handleIncomingRequest(message) {
    try {
      if (!this.onRequest) {
        throw new Error(`Unsupported Grok ACP request: ${message.method}`);
      }
      const result = await this.onRequest(message.method, message.params ?? {});
      this.write({ jsonrpc: "2.0", id: message.id, result: result ?? {} });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32603,
          message:
            error instanceof Error ? error.message : "Grok ACP request failed.",
        },
      });
    }
  }

  write(message) {
    if (this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (this.closed) {
      return Promise.reject(new Error("Grok ACP connection is closed."));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Grok ACP ${method} request timed out.`));
      }, timeoutMs);
      this.pending.set(id, { reject, resolve, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    this.failPending(new Error("Grok ACP connection closed."));
    this.child.kill();
  }
}

export const spawnGrokAcp = async (options = {}) => {
  const command = await resolveCliCommandPath("grok");
  if (!command) {
    throw new Error(
      "Grok Build CLI is not installed or not available on PATH.",
    );
  }

  const child = spawn(command, createGrokArgs(options), {
    cwd: options.cwd,
    env: {
      ...process.env,
      // Managed gateway MCPs materialize tool schemas under cwd. Dream does
      // not advertise those tools, so disable them unless the user opted in.
      GROK_MANAGED_MCPS_ENABLED: process.env.GROK_MANAGED_MCPS_ENABLED ?? "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new GrokAcpConnection(child);
};

export const initializeGrokAcp = (connection) =>
  connection.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });

export const authenticateGrokAcp = async (connection, initializeResult) => {
  const methods = Array.isArray(initializeResult?.authMethods)
    ? initializeResult.authMethods
    : [];
  const methodIds = new Set(
    methods.map((method) => method?.id).filter(Boolean),
  );
  const advertisedDefault = initializeResult?._meta?.defaultAuthMethodId;
  const methodId =
    (process.env.XAI_API_KEY && methodIds.has("xai.api_key")
      ? "xai.api_key"
      : null) ||
    (methodIds.has(advertisedDefault) && advertisedDefault !== "grok.com"
      ? advertisedDefault
      : null) ||
    (methodIds.has("cached_token") ? "cached_token" : null);

  if (!methodId) {
    throw new Error(
      "Grok Build is not authenticated. Run `grok login` or configure XAI_API_KEY.",
    );
  }

  try {
    await connection.request("authenticate", {
      methodId,
      _meta: { headless: true },
    });
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message
        ? `Grok authentication failed: ${error.message}`
        : "Grok authentication failed. Run `grok login` and try again.",
    );
  }
};

export const getGrokModelsFromInitializeResult = (initializeResult) => {
  const modelState = initializeResult?._meta?.modelState;
  return Array.isArray(modelState?.availableModels)
    ? modelState.availableModels
    : [];
};

export const runGrokPrompt = async ({
  cwd,
  model,
  prompt,
  reasoningEffort = "low",
  timeoutMs = 120_000,
}) => {
  let connection = null;
  let text = "";

  try {
    connection = await spawnGrokAcp({
      agentMode: "plan",
      codexPermissionMode: "default",
      cwd,
      model,
      reasoningEffort,
    });
    connection.onNotification = (method, params) => {
      const update = params?.update;
      if (
        method === "session/update" &&
        update?.sessionUpdate === "agent_message_chunk" &&
        typeof update.content?.text === "string"
      ) {
        text += update.content.text;
      }
    };
    connection.onRequest = (method) => {
      if (method === "session/request_permission") {
        return { outcome: { outcome: "cancelled" } };
      }
      throw new Error(`Unsupported Grok ACP request: ${method}`);
    };

    const initializeResult = await initializeGrokAcp(connection);
    await authenticateGrokAcp(connection, initializeResult);
    const session = await connection.request("session/new", {
      cwd,
      mcpServers: [],
    });
    if (!session?.sessionId) {
      throw new Error("Grok Build did not return a session id.");
    }
    await connection.request(
      "session/prompt",
      {
        prompt: [{ text: String(prompt ?? ""), type: "text" }],
        sessionId: session.sessionId,
      },
      timeoutMs,
    );
    return text.trim();
  } finally {
    connection?.close();
  }
};
