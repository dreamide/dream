import {
  authenticateGrokAcp,
  getGrokModelsFromInitializeResult,
  spawnGrokAcp,
} from "../providers/grok-acp.js";
import { streamAcpResponse } from "./acp-stream.js";

const toFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The numbers the turn writer formats, read off a prompt result's meta. */
export const getGrokUsage = (promptResult) => {
  const meta = promptResult?._meta;
  const inputTokens = toFiniteNumber(meta?.inputTokens);
  const outputTokens = toFiniteNumber(meta?.outputTokens);
  const reasoningTokens = toFiniteNumber(meta?.reasoningTokens) ?? 0;
  if (inputTokens === undefined && outputTokens === undefined) return null;

  return {
    cacheReadTokens: toFiniteNumber(meta?.cachedReadTokens) ?? 0,
    inputTokens: inputTokens ?? 0,
    // Grok counts reasoning inside output; Dream reports them apart.
    outputTokens: Math.max((outputTokens ?? 0) - reasoningTokens, 0),
    reasoningTokens,
  };
};

export const grokAcpAdapter = {
  provider: "grok",
  label: "Grok Build",
  spawn: spawnGrokAcp,
  authenticate: authenticateGrokAcp,
  getUsage: getGrokUsage,
  getContextWindow: (result, model) =>
    toFiniteNumber(
      getGrokModelsFromInitializeResult(result).find(
        (entry) => entry.modelId === model,
      )?._meta?.totalContextTokens,
    ),
  configureSession: async (
    connection,
    { sessionId, sessionState, permissionMode },
  ) => {
    const modeId =
      permissionMode === "full-access"
        ? "bypassPermissions"
        : permissionMode === "auto-accept-edits"
          ? "acceptEdits"
          : "default";
    if (
      sessionState?.modes?.availableModes?.some((mode) => mode.id === modeId)
    ) {
      await connection.request("session/set_mode", { sessionId, modeId });
    }
  },
};

export const streamGrokResponse = (options) =>
  streamAcpResponse({ ...options, adapter: grokAcpAdapter });
