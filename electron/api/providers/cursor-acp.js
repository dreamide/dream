import { spawn } from "node:child_process";
import os from "node:os";
import { AcpConnection } from "./acp-connection.js";
import { resolveCursorCliLaunch } from "./cursor-cli.js";

/**
 * Cursor Agent's ACP mode only accepts the model ids it lists on a session,
 * e.g. `default[]` (Auto) or `gpt-5.6-sol[context=272k,reasoning=medium,...]`.
 * The flat ids printed by `agent models` are rejected with "Invalid params".
 */
export const CURSOR_ACP_AUTO_MODEL_ID = "default[]";

const CURSOR_AUTO_ALIASES = new Set([
  "",
  "auto",
  "cursor-auto",
  "default",
  CURSOR_ACP_AUTO_MODEL_ID,
]);

export const spawnCursorAcp = async ({ cwd, permissionMode } = {}) => {
  const launch = await resolveCursorCliLaunch();
  // Ask and Auto-accept edits must receive ACP permission requests. Never
  // silently fall back to the old headless --force transport.
  const args = [...launch.argsPrefix];
  if (permissionMode === "full-access") args.push("--force");
  args.push("acp");
  return new AcpConnection(
    spawn(launch.command, args, {
      cwd,
      env: process.env,
      shell: launch.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }),
    "Cursor",
  );
};

export const authenticateCursorAcp = (connection) =>
  connection.request("authenticate", { methodId: "cursor_login" });

const initializeCursorAcp = async (connection) => {
  await connection.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "dream", version: "1" },
  });
  await authenticateCursorAcp(connection);
};

/** Dream keeps `auto` as Cursor Auto's id, as it always has. */
export const toDreamCursorModelId = (acpModelId) =>
  acpModelId === CURSOR_ACP_AUTO_MODEL_ID ? "auto" : acpModelId;

const getBaseModelId = (modelId) => modelId.replace(/\[.*$/, "");

/**
 * Maps a model selected in Dream to one this Cursor session accepts, or null.
 * Chats created before Dream read Cursor's models over ACP store the flat ids
 * from `agent models` (e.g. `gpt-5.6-sol-medium-fast`); those map to the ACP
 * model with the longest matching base name (`gpt-5.6-sol[...]`).
 */
export const resolveCursorAcpModelId = (model, availableModels) => {
  const requested = String(model ?? "").trim();
  if (CURSOR_AUTO_ALIASES.has(requested.toLowerCase())) {
    return CURSOR_ACP_AUTO_MODEL_ID;
  }

  const modelIds = (availableModels ?? [])
    .map((entry) => entry?.modelId)
    .filter((modelId) => typeof modelId === "string" && modelId);
  if (modelIds.includes(requested)) {
    return requested;
  }

  let bestMatch = null;
  for (const modelId of modelIds) {
    const base = getBaseModelId(modelId);
    if (!base || (requested !== base && !requested.startsWith(`${base}-`))) {
      continue;
    }
    if (!bestMatch || base.length > getBaseModelId(bestMatch).length) {
      bestMatch = modelId;
    }
  }
  return bestMatch;
};

/**
 * The models Cursor offers over ACP. They are only listed on a session, so
 * this opens one; an unused session is not kept in Cursor's history.
 */
export const fetchCursorAcpModels = async () => {
  const cwd = os.homedir();
  let connection;
  try {
    connection = await spawnCursorAcp({ cwd });
    await initializeCursorAcp(connection);
    const session = await connection.request("session/new", {
      cwd,
      mcpServers: [],
    });
    return Array.isArray(session?.models?.availableModels)
      ? session.models.availableModels
      : [];
  } finally {
    connection?.close();
  }
};
