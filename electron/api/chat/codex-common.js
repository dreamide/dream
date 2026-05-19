import { waitForToolApproval } from "../tool-approvals.js";

export const codexSessionsByChatId = new Map();

export const writeCodexTextPart = (writeEvent, id, text, type) => {
  if (!text) {
    return;
  }

  writeEvent({ type: `${type}-start`, id });
  writeEvent({ type: `${type}-delta`, delta: text, id });
  writeEvent({ type: `${type}-end`, id });
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
