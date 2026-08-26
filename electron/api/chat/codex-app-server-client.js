import { spawn } from "node:child_process";
import { stopChildProcess } from "../../process-tree.js";
import { readCodexChatGptAuthTokens } from "../providers/codex-auth.js";
import {
  findRateLimitsObject,
  storeProviderUsageLimitSnapshot,
} from "../providers/usage-limits.js";
import {
  getCodexCliSpawnErrorMessage,
  resolveCodexCliLaunch,
} from "./codex-cli-launch.js";

const MAX_STDERR_CHARS = 20_000;

let sharedClient = null;
let sharedClientPromise = null;

const getMessageThreadId = (message) => {
  const params = message?.params;
  if (!params || typeof params !== "object") {
    return null;
  }

  const candidates = [
    params.threadId,
    params.thread?.id,
    params.turn?.threadId,
    params.item?.threadId,
  ];
  return (
    candidates.find(
      (value) => typeof value === "string" && value.trim().length > 0,
    ) ?? null
  );
};

const createCodexAppServerClient = async ({ onClosed }) => {
  const launch = await resolveCodexCliLaunch();
  const child = spawn(
    launch.command,
    [
      ...launch.argsPrefix,
      "--enable",
      "default_mode_request_user_input",
      "app-server",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      shell: launch.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  const pendingRequests = new Map();
  const threadHandlers = new Map();
  const childThreadRoots = new Map();
  const knownThreadIds = new Set();
  let nextRequestId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let closed = false;
  let stopping = false;

  const appendStderr = (value) => {
    stderrBuffer = `${stderrBuffer}${value}`.slice(-MAX_STDERR_CHARS);
  };

  const sendJson = (message) => {
    if (closed || !child.stdin.writable) {
      throw new Error("Codex app-server is not running.");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const sendResponse = (id, result) => {
    sendJson({ id, jsonrpc: "2.0", result });
  };

  const sendErrorResponse = (id, errorMessage) => {
    sendJson({
      error: { code: -32_000, message: errorMessage },
      id,
      jsonrpc: "2.0",
    });
  };

  const sendRequest = (method, params) => {
    const id = nextRequestId++;
    const request = new Promise((resolve, reject) => {
      pendingRequests.set(id, { reject, resolve });
    });

    try {
      sendJson({ id, jsonrpc: "2.0", method, params });
    } catch (error) {
      pendingRequests.delete(id);
      return Promise.reject(error);
    }

    return request;
  };

  const resolveRootThreadId = (threadId) => {
    let currentThreadId = threadId;
    const visited = new Set();
    while (
      currentThreadId &&
      childThreadRoots.has(currentThreadId) &&
      !visited.has(currentThreadId)
    ) {
      visited.add(currentThreadId);
      currentThreadId = childThreadRoots.get(currentThreadId);
    }
    return currentThreadId;
  };

  const dispatchToThread = (message) => {
    const threadId = getMessageThreadId(message);
    if (!threadId) {
      return false;
    }

    const rootThreadId = resolveRootThreadId(threadId);
    const handlers = threadHandlers.get(rootThreadId);
    if (!handlers || handlers.size === 0) {
      return false;
    }

    for (const handler of handlers) {
      handler.onMessage(message);
    }
    return true;
  };

  const handleAuthRefreshRequest = async (message) => {
    try {
      const tokens = await readCodexChatGptAuthTokens();
      if (!tokens) {
        sendErrorResponse(message.id, "Codex login not found.");
        return;
      }
      sendResponse(message.id, tokens);
    } catch (error) {
      sendErrorResponse(
        message.id,
        error instanceof Error ? error.message : "Codex login refresh failed.",
      );
    }
  };

  const rememberThread = (thread) => {
    if (!thread?.id) {
      return;
    }
    knownThreadIds.add(thread.id);
    if (thread.parentThreadId) {
      childThreadRoots.set(
        thread.id,
        resolveRootThreadId(thread.parentThreadId),
      );
    }
  };

  const forgetThread = (threadId) => {
    if (!threadId) {
      return;
    }
    knownThreadIds.delete(threadId);
    childThreadRoots.delete(threadId);
  };

  const handleMessage = (message) => {
    if (!message || typeof message !== "object") {
      return;
    }

    const rateLimits = findRateLimitsObject(message);
    if (rateLimits) {
      storeProviderUsageLimitSnapshot("openai", rateLimits, "codex");
    }

    if (Object.hasOwn(message, "id") && message.method) {
      if (message.method === "account/chatgptAuthTokens/refresh") {
        void handleAuthRefreshRequest(message);
        return;
      }
      if (!dispatchToThread(message)) {
        sendErrorResponse(
          message.id,
          `No active Dream chat can handle ${message.method}.`,
        );
      }
      return;
    }

    if (Object.hasOwn(message, "id") && pendingRequests.has(message.id)) {
      const pending = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      if (message.result?.thread) {
        rememberThread(message.result.thread);
      }
      if (message.error) {
        pending.reject(
          new Error(message.error.message || "Codex app-server error."),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "thread/started") {
      rememberThread(message.params?.thread);
    }

    dispatchToThread(message);

    if (
      message.method === "thread/closed" ||
      message.method === "thread/deleted" ||
      message.method === "thread/archived"
    ) {
      forgetThread(getMessageThreadId(message));
    }
  };

  const handleStdoutChunk = (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        handleMessage(JSON.parse(trimmed));
      } catch {
        appendStderr(`${trimmed}\n`);
      }
    }
  };

  const handleProcessClosed = (error) => {
    if (closed) {
      return;
    }
    closed = true;

    const closeError =
      error instanceof Error
        ? error
        : new Error(
            stderrBuffer.trim() ||
              (stopping
                ? "Codex app-server stopped."
                : "Codex app-server exited unexpectedly."),
          );
    for (const pending of pendingRequests.values()) {
      pending.reject(closeError);
    }
    pendingRequests.clear();

    if (!stopping) {
      for (const handlers of threadHandlers.values()) {
        for (const handler of handlers) {
          handler.onDisconnect(closeError);
        }
      }
    }
    threadHandlers.clear();
    childThreadRoots.clear();
    knownThreadIds.clear();
    onClosed(client);
  };

  const client = {
    hasThread: (threadId) => knownThreadIds.has(threadId),
    isClosed: () => closed,
    registerThread: (threadId, handler) => {
      knownThreadIds.add(threadId);
      const handlers = threadHandlers.get(threadId) ?? new Set();
      handlers.add(handler);
      threadHandlers.set(threadId, handlers);

      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          threadHandlers.delete(threadId);
        }
      };
    },
    sendErrorResponse,
    sendRequest,
    sendResponse,
    stop: async () => {
      if (closed || stopping) {
        return;
      }
      stopping = true;
      await stopChildProcess(child);
      handleProcessClosed();
    },
  };

  child.stdout.on("data", handleStdoutChunk);
  child.stderr.on("data", (chunk) => appendStderr(chunk.toString()));
  child.stdin.on("error", (error) => handleProcessClosed(error));
  child.once("error", (error) => {
    handleProcessClosed(new Error(getCodexCliSpawnErrorMessage(error)));
  });
  child.once("close", (code) => {
    handleProcessClosed(
      stopping
        ? null
        : new Error(
            stderrBuffer.trim() || `Codex app-server exited with code ${code}.`,
          ),
    );
  });

  try {
    await sendRequest("initialize", {
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
      clientInfo: { name: "Dream", title: "Dream", version: "0.1.0" },
    });
    sendJson({ jsonrpc: "2.0", method: "initialized", params: {} });
  } catch (error) {
    await client.stop();
    throw error;
  }

  return client;
};

export const getCodexAppServerClient = () => {
  if (sharedClient && !sharedClient.isClosed()) {
    return Promise.resolve(sharedClient);
  }
  if (!sharedClientPromise) {
    sharedClientPromise = createCodexAppServerClient({
      onClosed: (client) => {
        if (sharedClient === client) {
          sharedClient = null;
        }
        sharedClientPromise = null;
      },
    })
      .then((client) => {
        sharedClient = client;
        return client;
      })
      .catch((error) => {
        sharedClient = null;
        sharedClientPromise = null;
        throw error;
      });
  }
  return sharedClientPromise;
};

export const stopCodexAppServer = async () => {
  const clientPromise = sharedClientPromise;
  sharedClient = null;
  sharedClientPromise = null;
  if (!clientPromise) {
    return;
  }

  try {
    const client = await clientPromise;
    await client.stop();
  } catch {
    // A failed startup has no remaining process to stop.
  }
};
