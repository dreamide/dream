import { spawn } from "node:child_process";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
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
  writeCodexApprovalRequest,
} from "./codex-common.js";
import {
  buildCodexConversationPrompt,
  getLatestUserMessage,
  prepareCodexPromptAttachments,
} from "./codex-prompt.js";

export const streamCodexAppServerResponse = ({
  abortSignal,
  codexPermissionMode,
  messages,
  model,
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

        const completeToolCall = (item) => {
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
            writeEvent({
              dynamic: true,
              output: {
                changes: item.changes ?? [],
                status: item.status ?? "completed",
              },
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

          if (method === "thread/started" && params?.thread?.id && chatId) {
            codexSessionsByChatId.set(chatId, {
              model,
              projectPath,
              sessionId: params.thread.id,
            });
            writer.write({
              messageMetadata: {
                ...responseMessageMetadata,
                remoteConversationId: params.thread.id,
                remoteConversationModel: model,
                remoteConversationProjectPath: projectPath,
              },
              type: "message-metadata",
            });
            return;
          }

          if (method === "item/started" && params?.item) {
            const item = params.item;
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
              completeToolCall(item);
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

            finish(resolve);
          }
        };

        const handleMessage = (message) => {
          if (!message || typeof message !== "object") {
            return;
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
              [...launch.argsPrefix, "app-server"],
              {
                env: process.env,
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
              capabilities: {},
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
              effort: getCodexReasoningEffort(reasoningEffort),
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
