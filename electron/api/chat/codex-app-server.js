// The Codex app-server translator: app-server notifications and requests
// become calls on the agent turn. Codex names its own items, so text and
// reasoning parts use item ids and end when their item completes.
import {
  getProjectGitDiff,
  listProjectGitChanges,
} from "../project-git-service.js";
import { beginBrowserTurn } from "./active-browser-turns.js";
import { streamAgentTurn } from "./agent-turn.js";
import { getCodexAppServerClient } from "./codex-app-server-client.js";
import {
  chooseCodexApprovalDecision,
  getCodexAppApprovalPolicy,
  getCodexAppSandboxMode,
  getCodexAppTurnSandboxPolicy,
  getCodexReasoningEffort,
  getCodexTokenCountUsage,
} from "./codex-common.js";
import {
  buildCodexAppServerConversationPrompt,
  getLatestUserMessage,
  getLatestUserPrompt,
  prepareCodexPromptAttachments,
} from "./codex-prompt.js";
import { shouldResumeProviderSession } from "./provider-session.js";

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const getString = (value) => (typeof value === "string" ? value : null);

const getNonEmptyString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const getFirstString = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
};

const parseJsonObject = (value) => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const normalizePathForCompare = (value) =>
  value.replace(/\\/g, "/").replace(/\/+$/g, "").toLowerCase();

const getProjectRelativeFilePath = (projectPath, filePath) => {
  if (!filePath) {
    return null;
  }

  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const normalizedProjectPath = projectPath
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  const filePathKey = normalizePathForCompare(normalizedFilePath);
  const projectPathKey = normalizePathForCompare(normalizedProjectPath);
  const projectPrefix = `${projectPathKey}/`;

  if (filePathKey.startsWith(projectPrefix)) {
    return normalizedFilePath.slice(normalizedProjectPath.length + 1);
  }

  return normalizedFilePath;
};

const getFileChangePath = (change) =>
  getFirstString(
    change?.path,
    change?.filePath,
    change?.file_path,
    change?.filename,
    change?.name,
    change?.file?.path,
    change?.file?.filePath,
    change?.file?.filename,
    change?.file?.name,
  );

const inferProjectGitStatus = (change) => {
  const normalizedStatus = String(
    change?.status ?? change?.kind ?? change?.type ?? "",
  ).toLowerCase();

  if (
    normalizedStatus.includes("add") ||
    normalizedStatus.includes("create") ||
    normalizedStatus.includes("new") ||
    normalizedStatus.includes("untracked")
  ) {
    return "untracked";
  }
  if (
    normalizedStatus.includes("delete") ||
    normalizedStatus.includes("remove")
  ) {
    return "deleted";
  }
  if (normalizedStatus.includes("rename")) {
    return "renamed";
  }
  if (normalizedStatus.includes("copy")) {
    return "copied";
  }

  return "modified";
};

const getMatchingGitChange = (gitChanges, projectPath, filePath) => {
  const projectRelativePath = getProjectRelativeFilePath(projectPath, filePath);
  if (!projectRelativePath) {
    return null;
  }

  const targetKey = normalizePathForCompare(projectRelativePath);
  return (
    gitChanges.find(
      (change) => normalizePathForCompare(change.path) === targetKey,
    ) ?? null
  );
};

const loadFileChangeDiff = async ({ change, gitChanges, projectPath }) => {
  const filePath = getFileChangePath(change);
  if (!filePath) {
    return null;
  }

  const matchingChange = getMatchingGitChange(
    gitChanges,
    projectPath,
    filePath,
  );
  const projectRelativePath = getProjectRelativeFilePath(projectPath, filePath);
  const diffPath = matchingChange?.path ?? projectRelativePath ?? filePath;
  const payload = await getProjectGitDiff(projectPath, diffPath, {
    previousPath: matchingChange?.previousPath ?? null,
    status: matchingChange?.status ?? inferProjectGitStatus(change),
  });

  if (!payload.diff.trim()) {
    return null;
  }

  return {
    diff: payload.diff,
    filePath: payload.filePath,
    previousPath: payload.previousPath,
    status: payload.status,
  };
};

export const normalizeCodexUserInputQuestions = (questions) => {
  if (!Array.isArray(questions)) {
    return [];
  }

  return questions.flatMap((question) => {
    if (!isRecord(question)) {
      return [];
    }

    const id = getNonEmptyString(question.id);
    const questionText = getNonEmptyString(question.question);
    if (!id || !questionText) {
      return [];
    }

    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (!isRecord(option)) {
            return [];
          }

          const label = getNonEmptyString(option.label);
          if (!label) {
            return [];
          }

          return [
            {
              description: getString(option.description) ?? "",
              label,
            },
          ];
        })
      : [];

    return [
      {
        header: getString(question.header) ?? "Question",
        id,
        isOther: question.isOther === true,
        isSecret: question.isSecret === true,
        options,
        question: questionText,
      },
    ];
  });
};

const parseQuestionApprovalAnswers = (reason) => {
  const parsed = parseJsonObject(reason);
  return isRecord(parsed?.answers) ? parsed.answers : {};
};

const normalizeQuestionAnswerValues = (value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
};

const getQuestionAnswerValues = (answers, question) => {
  for (const key of [question.id, question.question]) {
    const values = normalizeQuestionAnswerValues(answers[key]);
    if (values.length > 0) {
      return values;
    }
  }

  return [];
};

export const buildCodexUserInputResponse = ({ questions, reason }) => {
  const approvalAnswers = parseQuestionApprovalAnswers(reason);
  const answers = {};

  for (const question of questions) {
    const values = getQuestionAnswerValues(approvalAnswers, question);
    if (values.length > 0) {
      answers[question.id] = { answers: values };
    }
  }

  return { answers };
};

const buildQuestionUiOutput = ({ questions, reason }) => {
  const approvalAnswers = parseQuestionApprovalAnswers(reason);
  const answers = {};

  for (const question of questions) {
    const values = getQuestionAnswerValues(approvalAnswers, question);
    if (values.length > 0) {
      answers[question.question] = values.join(", ");
    }
  }

  return { answers };
};

const buildFileChangeOutput = async ({ item, projectPath }) => {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const output = {
    changes,
    diff: getString(item.diff) ?? getString(item.patch),
    filePath:
      getFirstString(item.filePath, item.path, item.file_path, item.file) ??
      getFileChangePath(changes[0]) ??
      null,
    status: item.status ?? "completed",
  };

  if (output.diff?.trim()) {
    return output;
  }

  try {
    const gitStatus = await listProjectGitChanges(projectPath);
    const enrichedChanges = await Promise.all(
      changes.map(async (change) => {
        if (!isRecord(change)) {
          return change;
        }

        const diff = await loadFileChangeDiff({
          change,
          gitChanges: gitStatus.changes,
          projectPath,
        }).catch(() => null);

        return diff
          ? {
              ...change,
              diff: diff.diff,
              previousPath: diff.previousPath,
              status: diff.status,
            }
          : change;
      }),
    );
    const diffs = enrichedChanges
      .map((change) => (isRecord(change) ? getString(change.diff) : null))
      .filter((diff) => diff?.trim());

    return {
      ...output,
      changes: enrichedChanges,
      diff: diffs.length > 0 ? diffs.join("\n\n") : output.diff,
    };
  } catch {
    return output;
  }
};

const normalizeCollabAgentToolName = (tool) =>
  String(tool ?? "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();

const isSpawnAgentToolItem = (item) =>
  (item?.type === "collabAgentToolCall" || item?.type === "dynamicToolCall") &&
  normalizeCollabAgentToolName(item.tool) === "spawnagent";

const getCollabAgentArguments = (item) => {
  if (isRecord(item?.arguments)) {
    return item.arguments;
  }

  return parseJsonObject(item?.arguments) ?? {};
};

const getCollabAgentStateEntries = (item) => {
  const args = getCollabAgentArguments(item);
  const states = isRecord(item?.agentsStates) ? item.agentsStates : {};
  const receiverThreadIds = Array.isArray(item?.receiverThreadIds)
    ? item.receiverThreadIds.filter((value) => typeof value === "string")
    : Array.isArray(args.receiverThreadIds)
      ? args.receiverThreadIds.filter((value) => typeof value === "string")
      : [];
  const threadIds = new Set([...receiverThreadIds, ...Object.keys(states)]);

  return [...threadIds].map((threadId) => {
    const state = isRecord(states[threadId]) ? states[threadId] : null;
    return {
      message: getString(state?.message),
      status:
        getString(state?.status) ??
        (item?.status === "failed" ? "errored" : "pendingInit"),
      threadId,
    };
  });
};

const formatAgentTaskName = (value) => {
  const name = getNonEmptyString(value);
  if (!name) {
    return null;
  }

  const formatted = name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return formatted
    ? `${formatted.charAt(0).toUpperCase()}${formatted.slice(1)}`
    : null;
};

const getAgentPathTaskName = (agentPath) => {
  const normalizedPath = getNonEmptyString(agentPath)?.replace(/\\/g, "/");
  const pathName = normalizedPath?.split("/").filter(Boolean).at(-1);
  return pathName && pathName.toLowerCase() !== "root"
    ? formatAgentTaskName(pathName)
    : null;
};

const buildCollabAgentInput = (item) => {
  const args = getCollabAgentArguments(item);
  const taskName = getFirstString(args.task_name, args.taskName);
  return {
    description:
      getFirstString(
        args.description,
        formatAgentTaskName(taskName),
        item.description,
      ) ?? "Agent task",
    prompt:
      getString(item.prompt) ??
      getString(args.prompt) ??
      getString(args.message),
    subagent_type:
      getFirstString(
        args.subagent_type,
        args.subagentType,
        item.agentRole,
        item.role,
      ) ?? "general-purpose",
  };
};

const buildSubagentActivityInput = (item, thread = null) => ({
  description:
    getFirstString(
      getAgentPathTaskName(item?.agentPath),
      formatAgentTaskName(thread?.agentNickname),
      formatAgentTaskName(thread?.agentRole),
    ) ?? "Agent task",
  prompt: getString(thread?.preview),
  subagent_type:
    getFirstString(thread?.agentRole, item?.agentRole) ?? "general-purpose",
});

const buildCollabAgentOutput = (item) => {
  const entries = getCollabAgentStateEntries(item);
  if (entries.length === 0) {
    return `Agent task ${
      item.status === "failed" || item.success === false
        ? "failed"
        : "completed"
    }.`;
  }

  return entries
    .map(({ message, status, threadId }) => {
      const detail = message ? `: ${message}` : "";
      return `- ${threadId.slice(0, 8)} — ${status}${detail}`;
    })
    .join("\n");
};

export const streamCodexAppServerResponse = ({
  abortSignal,
  permissionMode,
  mcpServers = [],
  messages,
  model,
  modelSpeed,
  projectId,
  projectReferencesPrompt,
  projectPath,
  reasoningEffort,
  remoteConversationId,
  remoteConversationModel,
  remoteConversationModelSpeed,
  remoteConversationProjectPath,
  responseMessageMetadata,
  systemPrompt,
}) => {
  // The shared Codex app-server reaches Dream's browser tools through a
  // project-agnostic MCP URL; this lets the endpoint map its calls back to
  // the project whose turn is running.
  const endBrowserTurn = beginBrowserTurn({ projectId, provider: "openai" });

  return streamAgentTurn({
    abortSignal,
    label: "Codex",
    messages,
    model,
    modelSpeed,
    projectPath,
    provider: "openai",
    responseMessageMetadata,
    execute: (turn) =>
      new Promise((resolve, reject) => {
        const commandOutputs = new Map();
        const activeSubagentToolCalls = new Set();
        const subagentThreadsById = new Map();
        const subagentToolCallIdsByThreadId = new Map();
        const pendingToolCompletions = new Set();
        let finished = false;
        let preparedAttachments = null;
        let rootThreadId = null;
        let rootTurnId = null;
        let appServerClient = null;
        let turnStartPromise = null;
        let unregisterThread = null;

        const finish = (callback) => {
          if (finished) return;
          finished = true;
          endBrowserTurn();
          abortSignal?.removeEventListener("abort", handleAbort);
          unregisterThread?.();
          unregisterThread = null;
          preparedAttachments?.cleanup?.();
          callback();
        };

        const trackToolCompletion = (completion) => {
          pendingToolCompletions.add(completion);
          completion
            .catch((error) => {
              console.error("[codex app-server tool completion]", error);
            })
            .finally(() => {
              pendingToolCompletions.delete(completion);
            });
        };

        const waitForPendingToolCompletions = async () => {
          while (pendingToolCompletions.size > 0) {
            await Promise.allSettled([...pendingToolCompletions]);
          }
        };

        const sendResponse = (id, result) => {
          appServerClient?.sendResponse(id, result);
        };

        const sendErrorResponse = (id, message) => {
          appServerClient?.sendErrorResponse(id, message);
        };

        const ensureCommandToolStarted = (item) =>
          turn.toolStart({
            input: {
              command: item.command ?? "",
              cwd: item.cwd ?? null,
              reason: item.reason ?? null,
            },
            title: "Command",
            toolCallId: item?.id,
            toolName: "runCommand",
          });

        const ensureFileToolStarted = (item) =>
          turn.toolStart({
            input: {
              changes: item.changes ?? [],
              reason: item.reason ?? null,
            },
            title: "File change",
            toolCallId: item?.id,
            toolName: "writeFile",
          });

        const getSubagentToolCallId = (threadId, fallbackId) => {
          const existingToolCallId = threadId
            ? subagentToolCallIdsByThreadId.get(threadId)
            : null;
          const toolCallId =
            existingToolCallId ??
            fallbackId ??
            (threadId ? `subagent-${threadId}` : null);
          if (threadId && toolCallId) {
            subagentToolCallIdsByThreadId.set(threadId, toolCallId);
          }

          return toolCallId;
        };

        const ensureAgentToolStarted = (toolCallId, input) => {
          if (
            turn.toolStart({
              input,
              title: "Agent task",
              toolCallId,
              toolName: "agent",
            })
          ) {
            activeSubagentToolCalls.add(toolCallId);
          }

          return toolCallId;
        };

        const ensureSpawnAgentToolStarted = (item, allowUnresolved = false) => {
          const threadId = getCollabAgentStateEntries(item).at(0)?.threadId;
          if (!threadId && !allowUnresolved) {
            return null;
          }

          const toolCallId = getSubagentToolCallId(
            threadId,
            allowUnresolved || threadId ? item?.id : null,
          );
          return ensureAgentToolStarted(
            toolCallId,
            buildCollabAgentInput(item),
          );
        };

        const ensureSubagentActivityToolStarted = (item, thread = null) => {
          const threadId = getFirstString(item?.agentThreadId, thread?.id);
          const threadDetails =
            thread ?? (threadId ? subagentThreadsById.get(threadId) : null);
          const toolCallId = getSubagentToolCallId(
            threadId,
            threadId ? `subagent-${threadId}` : item?.id,
          );
          return ensureAgentToolStarted(
            toolCallId,
            buildSubagentActivityInput(item, threadDetails),
          );
        };

        const completeSubagentTool = ({
          errorText = null,
          output = "Agent task completed.",
          threadId,
          toolCallId: explicitToolCallId = null,
        }) => {
          const toolCallId =
            explicitToolCallId ??
            (threadId ? subagentToolCallIdsByThreadId.get(threadId) : null);
          if (!toolCallId || !activeSubagentToolCalls.has(toolCallId)) {
            return;
          }

          activeSubagentToolCalls.delete(toolCallId);
          if (errorText) {
            turn.toolError(toolCallId, errorText);
          } else {
            turn.toolOutput(toolCallId, output);
          }
        };

        const completeToolCall = async (item) => {
          if (!item?.id) {
            return;
          }

          if (item.type === "commandExecution") {
            ensureCommandToolStarted(item);
            turn.toolOutput(item.id, {
              command: item.command ?? "",
              durationMs: item.durationMs ?? null,
              exitCode:
                typeof item.exitCode === "number" ? item.exitCode : null,
              output:
                item.aggregatedOutput ??
                commandOutputs.get(item.id)?.join("") ??
                "",
              status: item.status ?? "completed",
            });
            return;
          }

          if (isSpawnAgentToolItem(item)) {
            const toolCallId = ensureSpawnAgentToolStarted(item, true);
            const output = buildCollabAgentOutput(item);
            completeSubagentTool({
              errorText:
                item.status === "failed" || item.success === false
                  ? output
                  : null,
              output,
              toolCallId,
            });
            return;
          }

          if (item.type === "fileChange") {
            ensureFileToolStarted(item);
            const output = await buildFileChangeOutput({ item, projectPath });
            if (finished) {
              return;
            }

            turn.toolOutput(item.id, output);
          }
        };

        const handleServerRequest = async (message) => {
          const { id, method, params } = message;

          try {
            if (method === "item/commandExecution/requestApproval") {
              const toolCallId = params?.itemId ?? `codex-command-${id}`;
              const response = await turn.approval({
                input: {
                  command: params?.command ?? "",
                  cwd: params?.cwd ?? null,
                  reason: params?.reason ?? null,
                },
                request: { method, params },
                title: "Command",
                toolCallId,
                toolName: "runCommand",
              });
              sendResponse(id, {
                decision: chooseCodexApprovalDecision({
                  approved: response.approved,
                  availableDecisions: params?.availableDecisions,
                  scope: response.scope,
                }),
              });
              return;
            }

            if (method === "item/fileChange/requestApproval") {
              const toolCallId = params?.itemId ?? `codex-file-change-${id}`;
              const response = await turn.approval({
                input: {
                  grantRoot: params?.grantRoot ?? null,
                  reason: params?.reason ?? null,
                  title: params?.grantRoot
                    ? `Allow writes under ${params.grantRoot}?`
                    : "Allow file changes?",
                },
                request: { method, params },
                title: "File change",
                toolCallId,
                toolName: "writeFile",
              });
              sendResponse(id, {
                decision: chooseCodexApprovalDecision({
                  approved: response.approved,
                  scope: response.scope,
                }),
              });
              return;
            }

            if (method === "item/permissions/requestApproval") {
              const toolCallId = params?.itemId ?? `codex-permissions-${id}`;
              const response = await turn.approval({
                input: {
                  cwd: params?.cwd ?? null,
                  permissions: params?.permissions ?? null,
                  reason: params?.reason ?? null,
                  title: "Allow additional permissions?",
                },
                request: { method, params },
                title: "Permissions",
                toolCallId,
                toolName: "permissions",
              });

              sendResponse(id, {
                permissions: response.approved
                  ? (params?.permissions ?? {})
                  : {},
                scope: response.scope === "session" ? "session" : "turn",
                strictAutoReview: false,
              });
              return;
            }

            if (method === "item/tool/requestUserInput") {
              const questions = normalizeCodexUserInputQuestions(
                params?.questions,
              );
              const toolCallId = params?.itemId ?? `codex-question-${id}`;
              const response = await turn.approval({
                input: {
                  itemId: toolCallId,
                  questions,
                  threadId: params?.threadId ?? null,
                  turnId: params?.turnId ?? null,
                },
                request: { method, params },
                title: "Question",
                toolCallId,
                toolName: "ask-user-question",
              });

              if (!response.approved) {
                const message =
                  response.reason || "User cancelled the question request.";
                turn.toolError(toolCallId, message);
                sendErrorResponse(id, message);
                return;
              }

              turn.toolOutput(
                toolCallId,
                buildQuestionUiOutput({ questions, reason: response.reason }),
              );
              sendResponse(
                id,
                buildCodexUserInputResponse({
                  questions,
                  reason: response.reason,
                }),
              );
              return;
            }

            sendErrorResponse(
              id,
              `Unsupported Codex app-server request: ${method}`,
            );
          } catch (error) {
            sendErrorResponse(
              id,
              error instanceof Error
                ? error.message
                : "Failed to resolve approval request.",
            );
          }
        };

        const handleNotification = (message) => {
          const { method, params } = message;
          if (!method) {
            return;
          }

          if (method === "turn/plan/updated") {
            turn.todos(params);
            return;
          }

          if (method === "rawResponseItem/completed") {
            turn.todosFromTool(params?.item);
            return;
          }

          if (
            method === "thread/started" &&
            params?.thread?.id &&
            params.thread.parentThreadId
          ) {
            subagentThreadsById.set(params.thread.id, params.thread);
            return;
          }

          if (method === "thread/status/changed" && params?.threadId) {
            const thread = subagentThreadsById.get(params.threadId);
            if (
              !subagentToolCallIdsByThreadId.has(params.threadId) &&
              !thread
            ) {
              return;
            }

            if (params.status?.type === "idle") {
              ensureSubagentActivityToolStarted(null, thread);
              completeSubagentTool({ threadId: params.threadId });
            } else if (params.status?.type === "systemError") {
              ensureSubagentActivityToolStarted(null, thread);
              completeSubagentTool({
                errorText: "Agent task failed.",
                threadId: params.threadId,
              });
            }
            return;
          }

          if (method === "thread/closed" && params?.threadId) {
            completeSubagentTool({
              output: "Agent task closed.",
              threadId: params.threadId,
            });
            return;
          }

          if (method === "thread/started" && params?.thread?.id) {
            turn.session(params.thread.id);
            return;
          }

          if (
            method === "turn/started" &&
            params?.threadId === rootThreadId &&
            params?.turn?.id
          ) {
            rootTurnId = params.turn.id;
            return;
          }

          if (method === "item/started" && params?.item) {
            const item = params.item;
            if (item.type === "contextCompaction") {
              turn.compaction(item.id, "compacting");
              return;
            }
            if (turn.todosFromTool(item)) {
              return;
            }

            if (item.type === "commandExecution") {
              ensureCommandToolStarted(item);
            } else if (item.type === "fileChange") {
              ensureFileToolStarted(item);
            } else if (isSpawnAgentToolItem(item)) {
              ensureSpawnAgentToolStarted(item);
            } else if (item.type === "subAgentActivity") {
              ensureSubagentActivityToolStarted(item);
            } else if (item.type === "agentMessage") {
              turn.text("", item.id);
            } else if (item.type === "reasoning") {
              turn.reasoning("", item.id);
            }
            return;
          }

          if (method === "item/agentMessage/delta" && params?.itemId) {
            turn.text(params.delta ?? "", params.itemId);
            return;
          }

          if (method === "item/reasoning/textDelta" && params?.itemId) {
            turn.reasoning(params.delta ?? "", params.itemId);
            return;
          }

          if (
            method === "item/commandExecution/outputDelta" &&
            params?.itemId
          ) {
            const output = commandOutputs.get(params.itemId) ?? [];
            output.push(params.delta ?? "");
            commandOutputs.set(params.itemId, output);
            return;
          }

          if (method === "item/completed" && params?.item) {
            const item = params.item;
            if (item.type === "contextCompaction") {
              turn.compaction(item.id, "compacted");
              return;
            }
            if (turn.todosFromTool(item)) {
              return;
            }

            if (item.type === "agentMessage") {
              turn.endText(item.id, "text");
            } else if (item.type === "reasoning") {
              if (Array.isArray(item.summary) && item.summary.length > 0) {
                turn.reasoning(item.summary.join("\n"), item.id);
              }
              turn.endText(item.id, "reasoning");
            } else if (
              item.type === "subAgentActivity" &&
              item.kind === "interrupted"
            ) {
              ensureSubagentActivityToolStarted(item);
              completeSubagentTool({
                errorText: "Agent task was interrupted.",
                threadId: item.agentThreadId,
              });
            } else if (item.type !== "subAgentActivity") {
              trackToolCompletion(completeToolCall(item));
            } else {
              ensureSubagentActivityToolStarted(item);
            }
            return;
          }

          if (method === "turn/completed" && params?.turn) {
            if (!rootThreadId || params.threadId !== rootThreadId) {
              return;
            }

            const turnResult = params.turn;
            if (turnResult.status === "failed") {
              const turnError = new Error(
                turnResult.error?.message ||
                  turnResult.error?.additionalDetails ||
                  "Codex turn failed.",
              );
              finish(() => reject(turnError));
              return;
            }

            void (async () => {
              await waitForPendingToolCompletions();
              for (const toolCallId of activeSubagentToolCalls) {
                completeSubagentTool({ toolCallId });
              }
              finish(resolve);
            })();
          }
        };

        const handleMessage = (message) => {
          if (!message || typeof message !== "object") {
            return;
          }

          const tokenCount = getCodexTokenCountUsage(message);
          if (tokenCount) {
            turn.usage(tokenCount.usage, tokenCount.contextWindow);
          }

          if (Object.hasOwn(message, "id") && message.method) {
            void handleServerRequest(message);
            return;
          }

          handleNotification(message);
        };

        const handleAbort = () => {
          const interruptRequest = (async () => {
            if (!rootTurnId && turnStartPromise) {
              try {
                const turnResponse = await turnStartPromise;
                rootTurnId = turnResponse?.turn?.id ?? null;
              } catch {
                return;
              }
            }
            if (appServerClient && rootThreadId && rootTurnId) {
              await appServerClient.sendRequest("turn/interrupt", {
                threadId: rootThreadId,
                turnId: rootTurnId,
              });
            }
          })();
          void interruptRequest
            .catch(() => {
              // The turn may have completed while cancellation was in flight.
            })
            .finally(() => finish(resolve));
        };

        if (abortSignal?.aborted) {
          handleAbort();
          return;
        }
        abortSignal?.addEventListener("abort", handleAbort, { once: true });

        void getCodexAppServerClient({ mcpServers })
          .then(async (client) => {
            appServerClient = client;
            if (finished) {
              return;
            }
            preparedAttachments = await prepareCodexPromptAttachments(
              getLatestUserMessage(messages),
            );
            if (finished) {
              return;
            }
            const fullPrompt = buildCodexAppServerConversationPrompt({
              currentTurnAttachments: preparedAttachments?.promptText ?? null,
              currentTurnProjectReferences: projectReferencesPrompt,
              messages,
              projectPath,
              systemPrompt,
            });
            const currentTurnPrompt = getLatestUserPrompt(
              messages,
              preparedAttachments?.promptText ?? null,
              projectReferencesPrompt,
            );
            const sandbox = getCodexAppSandboxMode(permissionMode);
            const approvalPolicy = getCodexAppApprovalPolicy(permissionMode);
            const serviceTier = modelSpeed === "fast" ? "fast" : null;

            const shouldResume = shouldResumeProviderSession({
              model,
              modelSpeed,
              projectPath,
              remoteConversationId,
              remoteConversationModel,
              remoteConversationModelSpeed,
              remoteConversationProjectPath,
            });
            let resumed = false;
            let threadResponse = null;

            if (shouldResume) {
              if (client.hasThread(remoteConversationId)) {
                threadResponse = { thread: { id: remoteConversationId } };
                resumed = true;
              } else {
                let restoredPersistedThread = false;
                let forkedPersistedThread = false;
                try {
                  await client.sendRequest("thread/unarchive", {
                    threadId: remoteConversationId,
                  });
                  restoredPersistedThread = true;
                } catch {
                  // The id may belong to an ephemeral thread from an old process.
                }
                try {
                  threadResponse = await client.sendRequest("thread/fork", {
                    approvalPolicy,
                    approvalsReviewer: "user",
                    baseInstructions: systemPrompt,
                    config: null,
                    cwd: projectPath,
                    ephemeral: true,
                    model,
                    modelProvider: "openai",
                    sandbox,
                    serviceTier,
                    threadId: remoteConversationId,
                    threadSource: "dream",
                  });
                  resumed = true;
                  forkedPersistedThread = true;
                } catch (error) {
                  console.warn(
                    "[codex app-server] Dream thread could not be restored; starting a new thread.",
                    error instanceof Error ? error.message : error,
                  );
                } finally {
                  if (restoredPersistedThread || forkedPersistedThread) {
                    try {
                      await client.sendRequest("thread/archive", {
                        threadId: remoteConversationId,
                      });
                    } catch {
                      // Keep migration best-effort; the new thread is ephemeral.
                    }
                  }
                }
              }
            }

            if (!threadResponse) {
              threadResponse = await client.sendRequest("thread/start", {
                approvalPolicy,
                approvalsReviewer: "user",
                baseInstructions: systemPrompt,
                // MCP servers are applied via app-server argv overrides (see
                // getCodexAppServerClient); per-thread `config` hangs turns on
                // codex-cli 0.154.x (openai/codex#45361).
                config: null,
                cwd: projectPath,
                ephemeral: true,
                experimentalRawEvents: false,
                model,
                modelProvider: "openai",
                sandbox,
                serviceName: "Dream",
                serviceTier,
                threadSource: "dream",
              });
            }
            const threadId = threadResponse?.thread?.id;
            if (!threadId) {
              throw new Error("Codex app-server did not return a thread id.");
            }
            rootThreadId = threadId;
            unregisterThread = client.registerThread(threadId, {
              onDisconnect: (error) => {
                finish(() => reject(error));
              },
              onMessage: handleMessage,
            });
            turn.session(threadId);
            if (finished) {
              return;
            }

            turnStartPromise = client.sendRequest("turn/start", {
              approvalPolicy,
              approvalsReviewer: "user",
              ...(reasoningEffort
                ? { effort: getCodexReasoningEffort(reasoningEffort) }
                : {}),
              input: [
                {
                  text: resumed ? currentTurnPrompt : fullPrompt,
                  text_elements: [],
                  type: "text",
                },
              ],
              model,
              sandboxPolicy: getCodexAppTurnSandboxPolicy({
                permissionMode,
                projectPath,
              }),
              serviceTier,
              threadId,
            });
            const turnResponse = await turnStartPromise;
            rootTurnId = turnResponse?.turn?.id ?? rootTurnId;
          })
          .catch((error) => {
            const appServerError = new Error(
              error instanceof Error
                ? error.message
                : "Codex app-server request failed.",
            );
            finish(() => reject(appServerError));
          });
      }),
  });
};
