import { spawn } from "node:child_process";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  findRateLimitsObject,
  storeProviderUsageLimitSnapshot,
} from "../providers/usage-limits.js";
import {
  getCodexCliSpawnErrorMessage,
  resolveCodexCliLaunch,
} from "./codex-cli-launch.js";
import {
  buildCodexExecArgs,
  codexSessionsByChatId,
  writeCodexTextPart,
} from "./codex-common.js";
import {
  buildCodexConversationPrompt,
  getCodexErrorDetail,
  getCodexSessionId,
  getLatestUserMessage,
  getLatestUserPrompt,
  isCodexResumeFailure,
  prepareCodexPromptAttachments,
} from "./codex-prompt.js";

export const streamCodexCliResponse = ({
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
  remoteConversationId,
  remoteConversationModel,
  remoteConversationModelSpeed,
  remoteConversationProjectPath,
}) => {
  const storedSession = chatId
    ? (codexSessionsByChatId.get(chatId) ?? null)
    : null;
  const persistedSessionId =
    remoteConversationModel === model &&
    (remoteConversationModelSpeed ?? "standard") === modelSpeed &&
    remoteConversationProjectPath === projectPath
      ? getCodexSessionId(remoteConversationId)
      : null;
  const canResumeStoredSession =
    storedSession?.model === model &&
    (storedSession?.modelSpeed ?? "standard") === modelSpeed &&
    storedSession?.projectPath === projectPath;
  if (chatId && storedSession && !canResumeStoredSession) {
    codexSessionsByChatId.delete(chatId);
  }
  const initialSessionId = canResumeStoredSession
    ? (storedSession?.sessionId ?? null)
    : !storedSession
      ? persistedSessionId
      : null;

  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (error) =>
      error instanceof Error ? error.message : "Codex CLI request failed.",
    execute: ({ writer }) =>
      new Promise((resolve, reject) => {
        const startedToolCalls = new Set();
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let finished = false;
        let hasStreamedOutput = false;
        let latestUserPrompt = "";
        let preparedAttachments = null;
        let resumedRetryAttempted = false;
        let fullPrompt = "";
        let child;

        const finish = (callback) => {
          if (finished) return;
          finished = true;
          abortSignal?.removeEventListener("abort", handleAbort);
          preparedAttachments?.cleanup?.();
          callback();
        };

        const writeEvent = (event) => {
          hasStreamedOutput = true;
          writer.write(event);
        };

        writer.write({
          messageMetadata: responseMessageMetadata,
          type: "message-metadata",
        });

        const ensureCommandToolStarted = (item) => {
          if (!item?.id || startedToolCalls.has(item.id)) {
            return;
          }

          startedToolCalls.add(item.id);
          writeEvent({
            type: "tool-input-start",
            dynamic: true,
            title: "Command",
            toolCallId: item.id,
            toolName: "runCommand",
          });
          writeEvent({
            type: "tool-input-available",
            dynamic: true,
            input: {
              command: item.command ?? "",
            },
            title: "Command",
            toolCallId: item.id,
            toolName: "runCommand",
          });
        };

        const handleEvent = (event) => {
          if (!event || typeof event !== "object") {
            return;
          }

          const rateLimits = findRateLimitsObject(event);
          if (rateLimits) {
            storeProviderUsageLimitSnapshot("openai", rateLimits, "codex");
          }

          if (event.type === "error" || event.type === "turn.failed") {
            const detail = getCodexErrorDetail(event);
            if (detail) {
              stderrBuffer += `${detail}\n`;
            }
            return;
          }

          if (
            event.type === "thread.started" &&
            typeof event.thread_id === "string" &&
            chatId
          ) {
            codexSessionsByChatId.set(chatId, {
              model,
              modelSpeed,
              projectPath,
              sessionId: event.thread_id,
            });
            writer.write({
              messageMetadata: {
                ...responseMessageMetadata,
                remoteConversationId: event.thread_id,
                remoteConversationModel: model,
                remoteConversationProjectPath: projectPath,
              },
              type: "message-metadata",
            });
            return;
          }

          if (
            event.type === "item.started" &&
            event.item?.type === "command_execution"
          ) {
            ensureCommandToolStarted(event.item);
            return;
          }

          if (event.type !== "item.completed" || !event.item) {
            return;
          }

          const item = event.item;
          if (item.type === "agent_message" && typeof item.text === "string") {
            writeCodexTextPart(
              writeEvent,
              item.id ?? `text-${Date.now()}`,
              item.text,
              "text",
            );
            return;
          }

          if (item.type === "reasoning" && typeof item.text === "string") {
            writeCodexTextPart(
              writeEvent,
              item.id ?? `reasoning-${Date.now()}`,
              item.text,
              "reasoning",
            );
            return;
          }

          if (item.type === "command_execution") {
            ensureCommandToolStarted(item);
            writeEvent({
              type: "tool-output-available",
              dynamic: true,
              output: {
                command: item.command ?? "",
                exitCode:
                  typeof item.exit_code === "number" ? item.exit_code : null,
                output: item.aggregated_output ?? "",
                status: item.status ?? "completed",
              },
              toolCallId: item.id,
            });
            return;
          }

          if (typeof item.text === "string" && item.text.trim()) {
            writeCodexTextPart(
              writeEvent,
              item.id ?? `text-${Date.now()}`,
              item.text,
              "text",
            );
          }
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
              handleEvent(JSON.parse(trimmed));
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

        const runAttempt = (sessionId) => {
          stdoutBuffer = "";
          stderrBuffer = "";
          startedToolCalls.clear();
          hasStreamedOutput = false;

          const prompt = sessionId
            ? latestUserPrompt || fullPrompt
            : fullPrompt;
          const args = buildCodexExecArgs({
            addDirs: preparedAttachments?.addDirs ?? [],
            codexPermissionMode,
            imagePaths: preparedAttachments?.imagePaths ?? [],
            model,
            modelSpeed,
            projectPath,
            reasoningEffort,
            sessionId,
          });

          void resolveCodexCliLaunch()
            .then((launch) => {
              child = spawn(launch.command, [...launch.argsPrefix, ...args], {
                env: process.env,
                shell: launch.shell ?? false,
                stdio: ["pipe", "pipe", "pipe"],
              });

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
                const trimmed = stdoutBuffer.trim();
                if (trimmed) {
                  try {
                    handleEvent(JSON.parse(trimmed));
                  } catch {
                    stderrBuffer += `${trimmed}\n`;
                  }
                }

                if (code === 0 || abortSignal?.aborted) {
                  finish(resolve);
                  return;
                }

                const detail =
                  stderrBuffer.trim() || `Codex CLI exited with code ${code}.`;

                // If Codex lost the rollout backing this session, rebuild context and
                // continue from a fresh exec instead of surfacing a hard thread error.
                if (
                  sessionId &&
                  !resumedRetryAttempted &&
                  !hasStreamedOutput &&
                  isCodexResumeFailure(detail)
                ) {
                  resumedRetryAttempted = true;
                  if (chatId) {
                    codexSessionsByChatId.delete(chatId);
                  }
                  runAttempt(null);
                  return;
                }

                finish(() => reject(new Error(detail)));
              });

              child.stdin.end(prompt);
            })
            .catch((error) => {
              finish(() =>
                reject(
                  new Error(
                    error instanceof Error
                      ? error.message
                      : "Codex CLI request failed.",
                  ),
                ),
              );
            });
        };

        void prepareCodexPromptAttachments(getLatestUserMessage(messages))
          .then((attachments) => {
            preparedAttachments = attachments;
            fullPrompt = buildCodexConversationPrompt({
              currentTurnAttachments: attachments?.promptText ?? null,
              currentTurnProjectReferences: projectReferencesPrompt,
              messages,
              projectPath,
              systemPrompt,
            });
            latestUserPrompt = getLatestUserPrompt(
              messages,
              attachments?.promptText ?? null,
              projectReferencesPrompt,
            );
            runAttempt(initialSessionId);
          })
          .catch((error) => {
            finish(() =>
              reject(
                new Error(
                  error instanceof Error
                    ? error.message
                    : "Failed to prepare Codex attachments.",
                ),
              ),
            );
          });
      }),
  });

  return createUIMessageStreamResponse({ stream });
};
