// @ts-check
// The contract between an agent turn on the server and the chat client.
//
// The server writes a turn as AI SDK UI-message chunks; two things in that
// stream are Dream's own and have to be agreed on by both sides: the
// approval id a tool-approval request carries, and the metadata stamped on
// the response message. Both live here so neither side guesses.

/** @typedef {import("../../src/types/ide").AiProvider} AiProvider */
/** @typedef {import("../../src/types/ide").ProjectReference} ProjectReference */
/** @typedef {import("ai").LanguageModelUsage} LanguageModelUsage */

/**
 * The metadata a response message carries. The server stamps the request
 * fields when the turn starts, the remote session once the provider names
 * it, and usage when the turn ends; the client adds the timestamps.
 * @typedef {object} ChatMessageMetadata
 * @property {string} [checkpointId]
 * @property {string} [completedAt]
 * @property {number} [contextWindow]
 * @property {string} [createdAt]
 * @property {string} [model]
 * @property {string} [modelLabel]
 * @property {string} [modelSpeed]
 * @property {string} [modelSpeedLabel]
 * @property {ProjectReference[]} [projectReferences]
 * @property {string} [reasoningEffort]
 * @property {string} [reasoningLabel]
 * @property {string} [remoteConversationId]
 * @property {string} [remoteConversationModel]
 * @property {string} [remoteConversationModelSpeed]
 * @property {string} [remoteConversationProjectPath]
 * @property {string} [startedAt]
 * @property {LanguageModelUsage} [usage]
 */

const APPROVAL_ID_SEPARATOR = ":";

/**
 * The id a tool-approval request carries: the provider that owns the tool
 * call, then the tool call id. The same function on both sides is the whole
 * scheme.
 * @param {AiProvider} provider
 * @param {string} toolCallId
 * @returns {string}
 */
export const formatApprovalId = (provider, toolCallId) =>
  `${provider}${APPROVAL_ID_SEPARATOR}${toolCallId}`;

/**
 * @param {unknown} approvalId
 * @returns {{ provider: string, toolCallId: string } | null}
 */
export const parseApprovalId = (approvalId) => {
  if (typeof approvalId !== "string") {
    return null;
  }

  const separatorIndex = approvalId.indexOf(APPROVAL_ID_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === approvalId.length - 1) {
    return null;
  }

  return {
    provider: approvalId.slice(0, separatorIndex),
    toolCallId: approvalId.slice(separatorIndex + 1),
  };
};

/**
 * Claude's approvals are resolved by the AI SDK inside the client's `Chat`;
 * every other provider waits on Dream's own approval endpoint. The client
 * answers both through the endpoint, and skips the SDK path for Claude.
 * @param {unknown} approvalId
 * @returns {boolean}
 */
export const isAiSdkApproval = (approvalId) =>
  parseApprovalId(approvalId)?.provider === "anthropic";
