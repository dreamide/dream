import { waitForToolApproval } from "../tool-approvals.js";

export const codexSessionsByChatId = new Map();

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

export const getCodexTokenCountMetadata = (event) => {
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
  const contextInputTokens =
    knownTokens > 0 ? inputTokens : (totalTokens ?? inputTokens);
  const cacheReadTokens = toFiniteNumber(usage.cached_input_tokens);
  const modelContextWindow = toFiniteNumber(info.model_context_window);

  return {
    ...(modelContextWindow ? { contextWindow: modelContextWindow } : {}),
    usage: {
      inputTokens: contextInputTokens,
      outputTokens,
      ...(cacheReadTokens ? { cachedInputTokens: cacheReadTokens } : {}),
      ...(cacheReadTokens ? { inputTokenDetails: { cacheReadTokens } } : {}),
      ...(reasoningTokens ? { reasoningTokens } : {}),
      ...(reasoningTokens ? { outputTokenDetails: { reasoningTokens } } : {}),
    },
  };
};

export const writeCodexTextPart = (writeEvent, id, text, type) => {
  if (!text) {
    return;
  }

  writeEvent({ type: `${type}-start`, id });
  writeEvent({ type: `${type}-delta`, delta: text, id });
  writeEvent({ type: `${type}-end`, id });
};

const TODO_ARRAY_KEYS = [
  "plan",
  "todos",
  "tasks",
  "items",
  "steps",
  "entries",
  "data",
  "input",
  "arguments",
  "args",
  "result",
];

const getArrayFromPayload = (payload, keys = TODO_ARRAY_KEYS, depth = 0) => {
  if (depth > 4) {
    return null;
  }

  if (typeof payload === "string") {
    try {
      return getArrayFromPayload(JSON.parse(payload), keys, depth + 1);
    } catch {
      return null;
    }
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return null;
  }

  for (const key of keys) {
    const todos = getArrayFromPayload(payload[key], keys, depth + 1);
    if (todos) {
      return todos;
    }
  }

  return null;
};

const normalizeToolName = (toolName) =>
  String(toolName ?? "")
    .split(/[.:/]+/)
    .pop()
    .replace(/[\s_-]+/g, "")
    .toLowerCase();

const TODO_TOOL_NAMES = new Set([
  "todo",
  "todolist",
  "todos",
  "todowrite",
  "updateplan",
  "updatetodo",
  "updatetodos",
]);

export const writeCodexTodoListPart = (writeEvent, payload) => {
  const todos = getArrayFromPayload(payload);

  if (!todos) {
    return false;
  }

  writeEvent({
    data: {
      explanation:
        payload && typeof payload === "object"
          ? (payload.explanation ?? null)
          : null,
      todos,
    },
    id: "codex-todos",
    type: "data-todos",
  });

  return true;
};

export const writeCodexTodoListPartFromResponseItem = (writeEvent, item) => {
  const toolName = normalizeToolName(item?.name ?? item?.tool ?? item?.type);
  if (!TODO_TOOL_NAMES.has(toolName)) {
    return false;
  }

  return (
    writeCodexTodoListPart(writeEvent, item?.arguments) ||
    writeCodexTodoListPart(writeEvent, item?.input) ||
    writeCodexTodoListPart(writeEvent, item)
  );
};

export const buildCodexExecArgs = ({
  addDirs = [],
  codexPermissionMode,
  imagePaths = [],
  model,
  modelSpeed = "standard",
  projectPath,
  reasoningEffort,
  sessionId,
}) => {
  const sandboxMode =
    codexPermissionMode === "full-access"
      ? "danger-full-access"
      : "workspace-write";
  const approvalPolicy =
    codexPermissionMode === "default" ? "on-request" : "never";
  const sandboxConfig = ["-c", `sandbox_mode=${JSON.stringify(sandboxMode)}`];
  const approvalConfig = [
    "-c",
    `approval_policy=${JSON.stringify(approvalPolicy)}`,
  ];
  const addDirConfig = addDirs.flatMap((dir) => ["--add-dir", dir]);
  const imageConfig = imagePaths.flatMap((imagePath) => ["--image", imagePath]);
  const reasoningConfig = reasoningEffort
    ? ["-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`]
    : [];
  const speedConfig =
    modelSpeed === "fast" ? ["-c", 'service_tier="fast"'] : [];
  if (sessionId) {
    return [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      ...(model ? ["--model", model] : []),
      ...imageConfig,
      ...sandboxConfig,
      ...approvalConfig,
      ...reasoningConfig,
      ...speedConfig,
      sessionId,
      "-",
    ];
  }

  return [
    "exec",
    "--json",
    "--cd",
    projectPath,
    "--skip-git-repo-check",
    ...(model ? ["--model", model] : []),
    ...addDirConfig,
    ...imageConfig,
    ...sandboxConfig,
    ...approvalConfig,
    ...reasoningConfig,
    ...speedConfig,
    "-",
  ];
};

export const getCodexAppSandboxMode = (codexPermissionMode) => {
  if (codexPermissionMode === "full-access") {
    return "danger-full-access";
  }

  return "workspace-write";
};

export const getCodexAppTurnSandboxPolicy = ({
  codexPermissionMode,
  projectPath,
}) => {
  if (codexPermissionMode === "full-access") {
    return { type: "dangerFullAccess" };
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

export const getCodexAppApprovalPolicy = (codexPermissionMode) => {
  if (codexPermissionMode !== "default") {
    return "never";
  }

  return "untrusted";
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

export const writeCodexApprovalRequest = async ({
  approvalId,
  input,
  provider,
  request,
  signal,
  title,
  toolCallId,
  toolName,
  writer,
}) => {
  writer.write({
    dynamic: true,
    providerExecuted: true,
    title,
    toolCallId,
    toolName,
    type: "tool-input-start",
  });
  writer.write({
    dynamic: true,
    input,
    providerExecuted: true,
    title,
    toolCallId,
    toolName,
    type: "tool-input-available",
  });
  writer.write({
    approvalId,
    toolCallId,
    type: "tool-approval-request",
  });

  return waitForToolApproval({
    id: approvalId,
    provider,
    request,
    signal,
  });
};
