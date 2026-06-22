import { spawn } from "node:child_process";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  getProjectGitDiff,
  listProjectGitChanges,
} from "../project-git-service.js";
import { readCodexChatGptAuthTokens } from "../providers/codex-auth.js";
import {
  findRateLimitsObject,
  storeProviderUsageLimitSnapshot,
} from "../providers/usage-limits.js";
import {
  getCodexCliSpawnErrorMessage,
  resolveCodexCliLaunch,
} from "./codex-cli-launch.js";
import {
  chooseCodexApprovalDecision,
  codexSessionsByChatId,
  getCodexAppApprovalPolicy,
  getCodexAppSandboxMode,
  getCodexAppTurnSandboxPolicy,
  getCodexReasoningEffort,
  getCodexTokenCountMetadata,
  writeCodexApprovalRequest,
  writeCodexTodoListPart,
  writeCodexTodoListPartFromResponseItem,
} from "./codex-common.js";
import {
  buildCodexConversationPrompt,
  getLatestUserMessage,
  prepareCodexPromptAttachments,
} from "./codex-prompt.js";

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

const normalizeCodexUserInputQuestions = (questions) => {
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

const buildCodexUserInputResponse = ({ questions, reason }) => {
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

export const streamCodexAppServerResponse = ({
  abortSignal,
  codexPermissionMode,
  messages,
  model,
  modelSpeed,
  projectReferencesPrompt,
  projectPath,
  reasoningEffort,
  responseMessageMetadata,
  systemPrompt,
  chatId,
}) => {
  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (error) =>
      error instanceof Error
        ? error.message
        : "Codex app-server request failed.",
    execute: ({ writer }) =>
      new Promise((resolve, reject) => {
        const pendingRequests = new Map();
        const commandOutputs = new Map();
        const startedTextParts = new Set();
        const startedToolCalls = new Set();
        const pendingToolCompletions = new Set();
        let nextRequestId = 1;
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let finished = false;
        let preparedAttachments = null;
        let child;

        const finish = (callback) => {
          if (finished) return;
          finished = true;
          abortSignal?.removeEventListener("abort", handleAbort);
          if (child && !child.killed) {
            child.kill("SIGTERM");
          }
          preparedAttachments?.cleanup?.();
          for (const [, pending] of pendingRequests) {
            pending.reject(
              new Error("Codex app-server request was cancelled."),
            );
          }
          pendingRequests.clear();
          callback();
        };

        const writeEvent = (event) => {
          writer.write(event);
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

        const sendJson = (message) => {
          child?.stdin.write(`${JSON.stringify(message)}\n`);
        };

        const sendRequest = (method, params) => {
          const id = nextRequestId++;
          sendJson({ id, jsonrpc: "2.0", method, params });

          return new Promise((requestResolve, requestReject) => {
            pendingRequests.set(id, {
              reject: requestReject,
              resolve: requestResolve,
            });
          });
        };

        const sendResponse = (id, result) => {
          sendJson({ id, jsonrpc: "2.0", result });
        };

        const sendErrorResponse = (id, message) => {
          sendJson({
            error: { code: -32_000, message },
            id,
            jsonrpc: "2.0",
          });
        };

        const ensureTextStarted = (id, type = "text") => {
          if (startedTextParts.has(id)) {
            return;
          }

          startedTextParts.add(id);
          writeEvent({ id, type: `${type}-start` });
        };

        const endTextPart = (id, type = "text") => {
          if (!startedTextParts.has(id)) {
            return;
          }

          writeEvent({ id, type: `${type}-end` });
          startedTextParts.delete(id);
        };

        const ensureCommandToolStarted = (item) => {
          if (!item?.id || startedToolCalls.has(item.id)) {
            return;
          }

          startedToolCalls.add(item.id);
          writeEvent({
            dynamic: true,
            providerExecuted: true,
            title: "Command",
            toolCallId: item.id,
            toolName: "runCommand",
            type: "tool-input-start",
          });
          writeEvent({
            dynamic: true,
            input: {
              command: item.command ?? "",
              cwd: item.cwd ?? null,
              reason: item.reason ?? null,
            },
            providerExecuted: true,
            title: "Command",
            toolCallId: item.id,
            toolName: "runCommand",
            type: "tool-input-available",
          });
        };

        const ensureFileToolStarted = (item) => {
          if (!item?.id || startedToolCalls.has(item.id)) {
            return;
          }

          startedToolCalls.add(item.id);
          writeEvent({
            dynamic: true,
            providerExecuted: true,
            title: "File change",
            toolCallId: item.id,
            toolName: "writeFile",
            type: "tool-input-start",
          });
          writeEvent({
            dynamic: true,
            input: {
              changes: item.changes ?? [],
              reason: item.reason ?? null,
            },
            providerExecuted: true,
            title: "File change",
            toolCallId: item.id,
            toolName: "writeFile",
            type: "tool-input-available",
          });
        };

        const completeToolCall = async (item) => {
          if (!item?.id) {
            return;
          }

          if (item.type === "commandExecution") {
            ensureCommandToolStarted(item);
            writeEvent({
              dynamic: true,
              output: {
                command: item.command ?? "",
                durationMs: item.durationMs ?? null,
                exitCode:
                  typeof item.exitCode === "number" ? item.exitCode : null,
                output:
                  item.aggregatedOutput ??
                  commandOutputs.get(item.id)?.join("") ??
                  "",
                status: item.status ?? "completed",
              },
              providerExecuted: true,
              toolCallId: item.id,
              type: "tool-output-available",
            });
            return;
          }

          if (item.type === "fileChange") {
            ensureFileToolStarted(item);
            const output = await buildFileChangeOutput({ item, projectPath });
            if (finished) {
              return;
            }

            writeEvent({
              dynamic: true,
              output,
              providerExecuted: true,
              toolCallId: item.id,
              type: "tool-output-available",
            });
          }
        };

        const handleServerRequest = async (message) => {
          const { id, method, params } = message;

          try {
            if (method === "account/chatgptAuthTokens/refresh") {
              const tokens = await readCodexChatGptAuthTokens();
              if (!tokens) {
                sendErrorResponse(id, "Codex login not found.");
                return;
              }

              sendResponse(id, tokens);
              return;
            }

            if (method === "item/commandExecution/requestApproval") {
              const toolCallId = params?.itemId ?? `codex-command-${id}`;
              const approvalId = `codex:command:${params?.approvalId ?? toolCallId}`;
              const command = params?.command ?? "";
              const response = await writeCodexApprovalRequest({
                approvalId,
                input: {
                  command,
                  cwd: params?.cwd ?? null,
                  reason: params?.reason ?? null,
                },
                provider: "openai",
                request: { method, params },
                signal: abortSignal,
                title: "Command",
                toolCallId,
                toolName: "runCommand",
                writer,
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
              const approvalId = `codex:file:${toolCallId}`;
              const response = await writeCodexApprovalRequest({
                approvalId,
                input: {
                  grantRoot: params?.grantRoot ?? null,
                  reason: params?.reason ?? null,
                  title: params?.grantRoot
                    ? `Allow writes under ${params.grantRoot}?`
                    : "Allow file changes?",
                },
                provider: "openai",
                request: { method, params },
                signal: abortSignal,
                title: "File change",
                toolCallId,
                toolName: "writeFile",
                writer,
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
              const approvalId = `codex:permissions:${toolCallId}`;
              const response = await writeCodexApprovalRequest({
                approvalId,
                input: {
                  cwd: params?.cwd ?? null,
                  permissions: params?.permissions ?? null,
                  reason: params?.reason ?? null,
                  title: "Allow additional permissions?",
                },
                provider: "openai",
                request: { method, params },
                signal: abortSignal,
                title: "Permissions",
                toolCallId,
                toolName: "permissions",
                writer,
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
              const approvalId = [
                "codex",
                "question",
                params?.threadId,
                params?.turnId,
                toolCallId,
              ]
                .filter(Boolean)
                .join(":");
              const response = await writeCodexApprovalRequest({
                approvalId,
                input: {
                  itemId: toolCallId,
                  questions,
                  threadId: params?.threadId ?? null,
                  turnId: params?.turnId ?? null,
                },
                provider: "openai",
                request: { method, params },
                signal: abortSignal,
                title: "Question",
                toolCallId,
                toolName: "ask-user-question",
                writer,
              });

              if (!response.approved) {
                const message =
                  response.reason || "User cancelled the question request.";
                writer.write({
                  dynamic: true,
                  errorText: message,
                  providerExecuted: true,
                  toolCallId,
                  type: "tool-output-error",
                });
                sendErrorResponse(id, message);
                return;
              }

              writer.write({
                dynamic: true,
                output: buildQuestionUiOutput({
                  questions,
                  reason: response.reason,
                }),
                providerExecuted: true,
                toolCallId,
                type: "tool-output-available",
              });
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
            writeCodexTodoListPart(writeEvent, params);
            return;
          }

          if (method === "rawResponseItem/completed") {
            writeCodexTodoListPartFromResponseItem(writeEvent, params?.item);
            return;
          }

          if (method === "thread/started" && params?.thread?.id && chatId) {
            codexSessionsByChatId.set(chatId, {
              model,
              modelSpeed,
              projectPath,
              sessionId: params.thread.id,
            });
            writer.write({
              messageMetadata: {
                ...responseMessageMetadata,
                remoteConversationId: params.thread.id,
                remoteConversationModel: model,
                remoteConversationModelSpeed: modelSpeed,
                remoteConversationProjectPath: projectPath,
              },
              type: "message-metadata",
            });
            return;
          }

          if (method === "item/started" && params?.item) {
            const item = params.item;
            if (writeCodexTodoListPartFromResponseItem(writeEvent, item)) {
              return;
            }

            if (item.type === "commandExecution") {
              ensureCommandToolStarted(item);
            } else if (item.type === "fileChange") {
              ensureFileToolStarted(item);
            } else if (item.type === "agentMessage") {
              ensureTextStarted(item.id, "text");
            } else if (item.type === "reasoning") {
              ensureTextStarted(item.id, "reasoning");
            }
            return;
          }

          if (method === "item/agentMessage/delta" && params?.itemId) {
            ensureTextStarted(params.itemId, "text");
            writeEvent({
              delta: params.delta ?? "",
              id: params.itemId,
              type: "text-delta",
            });
            return;
          }

          if (method === "item/reasoning/textDelta" && params?.itemId) {
            ensureTextStarted(params.itemId, "reasoning");
            writeEvent({
              delta: params.delta ?? "",
              id: params.itemId,
              type: "reasoning-delta",
            });
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
            if (writeCodexTodoListPartFromResponseItem(writeEvent, item)) {
              return;
            }

            if (item.type === "agentMessage") {
              endTextPart(item.id, "text");
            } else if (item.type === "reasoning") {
              if (Array.isArray(item.summary) && item.summary.length > 0) {
                ensureTextStarted(item.id, "reasoning");
                writeEvent({
                  delta: item.summary.join("\n"),
                  id: item.id,
                  type: "reasoning-delta",
                });
              }
              endTextPart(item.id, "reasoning");
            } else {
              trackToolCompletion(completeToolCall(item));
            }
            return;
          }

          if (method === "turn/completed" && params?.turn) {
            const turn = params.turn;
            if (turn.status === "failed") {
              finish(() =>
                reject(
                  new Error(
                    turn.error?.message ||
                      turn.error?.additionalDetails ||
                      "Codex turn failed.",
                  ),
                ),
              );
              return;
            }

            void (async () => {
              await waitForPendingToolCompletions();
              finish(resolve);
            })();
          }
        };

        const handleMessage = (message) => {
          if (!message || typeof message !== "object") {
            return;
          }

          const tokenCountMetadata = getCodexTokenCountMetadata(message);
          if (tokenCountMetadata) {
            writer.write({
              messageMetadata: {
                ...responseMessageMetadata,
                ...tokenCountMetadata,
              },
              type: "message-metadata",
            });
          }

          const rateLimits = findRateLimitsObject(message);
          if (rateLimits) {
            storeProviderUsageLimitSnapshot("openai", rateLimits, "codex");
          }

          if (Object.hasOwn(message, "id") && pendingRequests.has(message.id)) {
            const pending = pendingRequests.get(message.id);
            pendingRequests.delete(message.id);

            if (message.error) {
              pending.reject(
                new Error(message.error.message || "Codex app-server error."),
              );
            } else {
              pending.resolve(message.result);
            }
            return;
          }

          if (Object.hasOwn(message, "id") && message.method) {
            void handleServerRequest(message);
            return;
          }

          handleNotification(message);
        };

        const handleStdoutChunk = (chunk) => {
          stdoutBuffer += chunk.toString();
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) {
              continue;
            }

            try {
              handleMessage(JSON.parse(trimmed));
            } catch {
              stderrBuffer += `${trimmed}\n`;
            }
          }
        };

        const handleAbort = () => {
          child?.kill("SIGTERM");
          finish(resolve);
        };

        abortSignal?.addEventListener("abort", handleAbort, { once: true });
        writer.write({
          messageMetadata: responseMessageMetadata,
          type: "message-metadata",
        });

        void resolveCodexCliLaunch()
          .then(async (launch) => {
            child = spawn(
              launch.command,
              [
                ...launch.argsPrefix,
                ...(modelSpeed === "fast" ? ["-c", 'service_tier="fast"'] : []),
                "--enable",
                "default_mode_request_user_input",
                "app-server",
              ],
              {
                cwd: projectPath,
                env: process.env,
                shell: launch.shell ?? false,
                stdio: ["pipe", "pipe", "pipe"],
              },
            );

            child.stdout.on("data", handleStdoutChunk);
            child.stderr.on("data", (chunk) => {
              stderrBuffer += chunk.toString();
            });
            child.on("error", (error) => {
              finish(() =>
                reject(new Error(getCodexCliSpawnErrorMessage(error))),
              );
            });
            child.on("close", (code) => {
              if (finished) {
                return;
              }

              const detail =
                stderrBuffer.trim() ||
                `Codex app-server exited with code ${code}.`;
              finish(() => reject(new Error(detail)));
            });

            preparedAttachments = await prepareCodexPromptAttachments(
              getLatestUserMessage(messages),
            );
            const fullPrompt = buildCodexConversationPrompt({
              currentTurnAttachments: preparedAttachments?.promptText ?? null,
              currentTurnProjectReferences: projectReferencesPrompt,
              messages,
              projectPath,
              systemPrompt,
            });
            const sandbox = getCodexAppSandboxMode(codexPermissionMode);
            const approvalPolicy =
              getCodexAppApprovalPolicy(codexPermissionMode);

            await sendRequest("initialize", {
              capabilities: {
                experimentalApi: true,
                requestAttestation: false,
              },
              clientInfo: { name: "Dream", version: "0.1.0" },
            });
            const threadResponse = await sendRequest("thread/start", {
              approvalPolicy,
              approvalsReviewer: "user",
              baseInstructions: systemPrompt,
              config: null,
              cwd: projectPath,
              ephemeral: true,
              experimentalRawEvents: false,
              model,
              modelProvider: "openai",
              persistExtendedHistory: false,
              sandbox,
            });
            const threadId = threadResponse?.thread?.id;
            if (!threadId) {
              throw new Error("Codex app-server did not return a thread id.");
            }

            await sendRequest("turn/start", {
              approvalPolicy,
              approvalsReviewer: "user",
              ...(reasoningEffort
                ? { effort: getCodexReasoningEffort(reasoningEffort) }
                : {}),
              input: [{ text: fullPrompt, text_elements: [], type: "text" }],
              model,
              sandboxPolicy: getCodexAppTurnSandboxPolicy({
                codexPermissionMode,
                projectPath,
              }),
              threadId,
            });
          })
          .catch((error) => {
            finish(() =>
              reject(
                new Error(
                  error instanceof Error
                    ? error.message
                    : "Codex app-server request failed.",
                ),
              ),
            );
          });
      }),
  });

  return createUIMessageStreamResponse({ stream });
};
