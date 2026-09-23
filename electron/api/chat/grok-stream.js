import {
  authenticateGrokAcp,
  getGrokModelsFromInitializeResult,
  spawnGrokAcp,
} from "../providers/grok-acp.js";
import { streamAcpResponse } from "./acp-stream.js";

const toFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const getGrokUsageMetadata = (promptResult) => {
  const meta = promptResult?._meta;
  const inputTokens = toFiniteNumber(meta?.inputTokens);
  const outputTokens = toFiniteNumber(meta?.outputTokens);
  const reasoningTokens = toFiniteNumber(meta?.reasoningTokens) ?? 0;
  const cacheReadTokens = toFiniteNumber(meta?.cachedReadTokens);
  if (inputTokens === undefined && outputTokens === undefined) return null;

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: Math.max((outputTokens ?? 0) - reasoningTokens, 0),
    ...(cacheReadTokens ? { cachedInputTokens: cacheReadTokens } : {}),
    ...(cacheReadTokens ? { inputTokenDetails: { cacheReadTokens } } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
    ...(reasoningTokens ? { outputTokenDetails: { reasoningTokens } } : {}),
  };
};

export const streamGrokResponse = (options) =>
  streamAcpResponse({
    ...options,
    adapter: {
      provider: "grok",
      label: "Grok Build",
      spawn: spawnGrokAcp,
      authenticate: authenticateGrokAcp,
      getUsage: getGrokUsageMetadata,
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
          sessionState?.modes?.availableModes?.some(
            (mode) => mode.id === modeId,
          )
        ) {
          await connection.request("session/set_mode", { sessionId, modeId });
        }
      },
    },
  });
