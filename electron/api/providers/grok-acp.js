import { spawn } from "node:child_process";
import { resolveCliCommandPath } from "../shared/cli.js";
import { AcpConnection, initializeAcp } from "./acp-transport.js";

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
  return new AcpConnection(child, "Grok", "Grok CLI");
};

export const initializeGrokAcp = initializeAcp;

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
