import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCliCommandPath } from "../shared/cli.js";
import { AcpConnection, initializeAcp } from "./acp-transport.js";

export const MINIMUM_AMP_ACP_VERSION = "0.9.0";
const AMP_NO_TOOLS_SETTINGS = {
  "amp.mcpPermissions": [
    { action: "reject", matches: { command: "*" } },
    { action: "reject", matches: { url: "*" } },
  ],
  "amp.tools.disable": ["*"],
};

export const isAmpAcpVersionSupported = (version) => {
  const match = String(version ?? "").match(
    /^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return false;

  const current = match.slice(1).map(Number);
  const minimum = MINIMUM_AMP_ACP_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
};

export const spawnAmpAcp = async ({ cwd, env } = {}) => {
  const command = await resolveCliCommandPath("amp-acp");
  if (!command) {
    throw new Error(
      "Amp ACP adapter is not installed or available on PATH. Install amp-acp and run `amp login` or complete adapter setup.",
    );
  }

  const child = spawn(command, [], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new AcpConnection(child, "Amp");
};

export const initializeAmpAcp = async (connection, timeoutMs) => {
  const result = await initializeAcp(connection, timeoutMs);
  const name = result?.agentInfo?.name;
  const version = result?.agentInfo?.version;
  if (name !== "amp-acp") {
    throw new Error(
      `Unexpected ACP adapter ${name || "without an agent name"}; expected amp-acp.`,
    );
  }
  if (!isAmpAcpVersionSupported(version)) {
    const error = new Error(
      `amp-acp ${version || "with an unknown version"} is incompatible with current Amp CLI releases. Install amp-acp ${MINIMUM_AMP_ACP_VERSION} or newer.`,
    );
    error.ampAcpVersion = typeof version === "string" ? version : null;
    throw error;
  }
  return result;
};

export const getAmpConfigOptions = (session) =>
  Array.isArray(session?.configOptions) ? session.configOptions : [];

export const getAmpModelOptions = (session) => {
  const option = getAmpConfigOptions(session).find(
    (entry) => entry?.category === "model" && entry?.id === "amp-mode",
  );
  return Array.isArray(option?.options)
    ? option.options
    : Array.isArray(option?.values)
      ? option.values
      : [];
};

export const getAmpReasoningEfforts = (session) => {
  const option = getAmpConfigOptions(session).find(
    (entry) => entry?.category === "thought_level" && entry?.id === "effort",
  );
  const values = Array.isArray(option?.options)
    ? option.options
    : Array.isArray(option?.values)
      ? option.values
      : [];

  return values.flatMap((entry) => {
    const value =
      typeof entry === "string" ? entry : (entry?.value ?? entry?.id);
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  });
};

const optionSupports = (option, value) => {
  const values = Array.isArray(option?.options)
    ? option.options
    : option?.values;
  return (
    Array.isArray(values) &&
    values.some(
      (entry) =>
        (typeof entry === "string" ? entry : (entry?.value ?? entry?.id)) ===
        value,
    )
  );
};

export const applyAmpSessionOptions = async (
  connection,
  session,
  { model, codexPermissionMode, reasoningEffort } = {},
  timeoutMs,
) => {
  let options = getAmpConfigOptions(session);
  const required = [
    ["amp-mode", model, "model"],
    [
      "permission",
      codexPermissionMode === "full-access" ? "bypass" : "default",
      "permission mode",
    ],
  ];

  for (const [configId, value, label] of required) {
    const option = options.find((entry) => entry?.id === configId);
    if (!value) {
      throw new Error(`Amp ACP requires a ${label} selection.`);
    }
    if (!optionSupports(option, value)) {
      throw new Error(
        `Amp ACP does not support the requested ${label} "${value}".`,
      );
    }

    const params = {
      sessionId: session.sessionId,
      configId,
      value,
    };
    const result =
      timeoutMs === undefined
        ? await connection.request("session/set_config_option", params)
        : await connection.request(
            "session/set_config_option",
            params,
            timeoutMs,
          );
    if (Array.isArray(result?.configOptions)) {
      options = result.configOptions;
    }
  }

  const effortOption = options.find((entry) => entry?.id === "effort");
  if (reasoningEffort && optionSupports(effortOption, reasoningEffort)) {
    const params = {
      sessionId: session.sessionId,
      configId: "effort",
      value: reasoningEffort,
    };
    if (timeoutMs === undefined) {
      await connection.request("session/set_config_option", params);
    } else {
      await connection.request("session/set_config_option", params, timeoutMs);
    }
  }
};

export const runAmpPrompt = async ({
  cwd,
  model,
  prompt,
  timeoutMs = 120_000,
}) => {
  let connection;
  let sessionId = null;
  let settingsDirectory = null;
  let text = "";

  try {
    settingsDirectory = await fs.mkdtemp(path.join(tmpdir(), "dream-amp-"));
    const settingsPath = path.join(settingsDirectory, "settings.json");
    await fs.writeFile(settingsPath, JSON.stringify(AMP_NO_TOOLS_SETTINGS), {
      mode: 0o600,
    });
    connection = await spawnAmpAcp({
      cwd,
      env: { AMP_SETTINGS_FILE: settingsPath },
    });
    connection.onNotification = (method, params) => {
      if (
        method === "session/update" &&
        params?.update?.sessionUpdate === "agent_message_chunk"
      ) {
        text += params.update.content?.text ?? "";
      }
    };
    connection.onRequest = () => ({ outcome: { outcome: "cancelled" } });
    await initializeAmpAcp(connection, timeoutMs);
    const session = await connection.request(
      "session/new",
      {
        cwd,
        mcpServers: [],
      },
      timeoutMs,
    );
    if (!session?.sessionId)
      throw new Error("Amp did not return a session id.");
    sessionId = session.sessionId;
    await applyAmpSessionOptions(
      connection,
      session,
      {
        model,
        codexPermissionMode: "default",
        reasoningEffort: "high",
      },
      timeoutMs,
    );
    await connection.request(
      "session/prompt",
      {
        prompt: [{ text: String(prompt ?? ""), type: "text" }],
        sessionId,
      },
      timeoutMs,
    );
    return text.trim();
  } catch (error) {
    if (connection && sessionId) {
      connection.notify("session/cancel", { sessionId });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw error;
  } finally {
    connection?.close();
    if (settingsDirectory) {
      await fs
        .rm(settingsDirectory, { force: true, recursive: true })
        .catch(() => {});
    }
  }
};
