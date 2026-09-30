// Codex policy: how Dream's permission modes and settings map onto the
// Codex app-server's sandbox, approval and effort vocabulary, and how its
// token counts are read. Nothing here writes to the chat stream; that is
// the agent-turn writer's job.

const toFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export const getCodexTokenCountInfo = (event) => {
  if (!event || typeof event !== "object") {
    return null;
  }

  if (event.type === "token_count") {
    return event.info && typeof event.info === "object" ? event.info : null;
  }

  if (event.type === "event_msg" && event.payload?.type === "token_count") {
    return event.payload.info && typeof event.payload.info === "object"
      ? event.payload.info
      : null;
  }

  if (event.method === "token_count") {
    const params = event.params;
    if (params?.info && typeof params.info === "object") {
      return params.info;
    }
    return params && typeof params === "object" ? params : null;
  }

  return null;
};

/**
 * The usage a Codex token-count event reports, as the numbers the turn
 * writer formats: `{ contextWindow?, usage: { inputTokens, outputTokens,
 * reasoningTokens, cacheReadTokens } }`, or null when the event is not one.
 */
export const getCodexTokenCountUsage = (event) => {
  const info = getCodexTokenCountInfo(event);
  if (!info) {
    return null;
  }

  const usage = info.last_token_usage ?? info.total_token_usage;
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const inputTokens = toFiniteNumber(usage.input_tokens) ?? 0;
  const outputTokens = toFiniteNumber(usage.output_tokens) ?? 0;
  const reasoningTokens = toFiniteNumber(usage.reasoning_output_tokens) ?? 0;
  const totalTokens = toFiniteNumber(usage.total_tokens);
  const knownTokens = inputTokens + outputTokens + reasoningTokens;
  const contextWindow = toFiniteNumber(info.model_context_window);

  return {
    ...(contextWindow ? { contextWindow } : {}),
    usage: {
      cacheReadTokens: toFiniteNumber(usage.cached_input_tokens) ?? 0,
      inputTokens: knownTokens > 0 ? inputTokens : (totalTokens ?? inputTokens),
      outputTokens,
      reasoningTokens,
    },
  };
};

export const getCodexAppSandboxMode = (permissionMode) => {
  if (permissionMode === "full-access") {
    return "danger-full-access";
  }

  return permissionMode === "auto-accept-edits"
    ? "workspace-write"
    : "read-only";
};

export const getCodexAppTurnSandboxPolicy = ({
  permissionMode,
  projectPath,
}) => {
  if (permissionMode === "full-access") {
    return { type: "dangerFullAccess" };
  }

  if (permissionMode !== "auto-accept-edits") {
    return { type: "readOnly" };
  }

  return {
    excludeSlashTmp: false,
    excludeTmpdirEnvVar: false,
    networkAccess: false,
    readOnlyAccess: { type: "fullAccess" },
    type: "workspaceWrite",
    writableRoots: [projectPath],
  };
};

export const getCodexAppApprovalPolicy = (permissionMode) => {
  if (permissionMode === "full-access") {
    return "never";
  }

  return permissionMode === "auto-accept-edits" ? "on-request" : "untrusted";
};

export const getCodexReasoningEffort = (reasoningEffort) =>
  reasoningEffort === "max" ? "xhigh" : (reasoningEffort ?? "medium");

export const chooseCodexApprovalDecision = ({
  approved,
  availableDecisions,
  onceDecision = "accept",
  sessionDecision = "acceptForSession",
  rejectedDecision = "decline",
  scope,
}) => {
  const decisions = Array.isArray(availableDecisions)
    ? availableDecisions.filter((decision) => typeof decision === "string")
    : null;
  const canUse = (decision) => !decisions || decisions.includes(decision);

  if (!approved) {
    return canUse(rejectedDecision) ? rejectedDecision : "cancel";
  }

  if (scope === "session" && canUse(sessionDecision)) {
    return sessionDecision;
  }

  return onceDecision;
};
