import { spawn } from "node:child_process";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  getProjectGitDiff,
  listProjectGitChanges,
} from "../project-git-service.js";
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
  getCodexTokenCountMetadata,
  writeCodexTextPart,
  writeCodexTodoListPart,
  writeCodexTodoListPartFromResponseItem,
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

const CODEX_CLI_FILE_CHANGE_ITEM_TYPES = new Set([
  "apply_patch",
  "file_change",
  "fileChange",
  "patch",
]);

const isCodexCliFileChangeItem = (item) =>
  CODEX_CLI_FILE_CHANGE_ITEM_TYPES.has(item?.type);

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const getString = (value) => (typeof value === "string" ? value : null);

const getFirstString = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
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

const buildFileChangeOutput = async ({ item, projectPath }) => {
  const changes = Array.isArray(item.changes)
    ? item.changes
    : Array.isArray(item.files)
      ? item.files
      : [];
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
        const pendingOutputWrites = new Set();

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

        const finishAfterPendingOutputWrites = (callback) => {
          if (pendingOutputWrites.size === 0) {
            finish(callback);
            return;
          }

          void Promise.allSettled([...pendingOutputWrites]).finally(() => {
            finish(callback);
          });
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

        const ensureFileToolStarted = (item) => {
          if (!item?.id || startedToolCalls.has(item.id)) {
            return;
          }

          startedToolCalls.add(item.id);
          writeEvent({
            type: "tool-input-start",
            dynamic: true,
            title: "File change",
            toolCallId: item.id,
            toolName: "writeFile",
          });
          writeEvent({
            type: "tool-input-available",
            dynamic: true,
            input: {
              changes: item.changes ?? item.files ?? [],
              diff: item.diff ?? item.patch ?? null,
              filePath:
                item.filePath ??
                item.path ??
                item.file_path ??
                item.file ??
                null,
              reason: item.reason ?? null,
            },
            title: "File change",
            toolCallId: item.id,
            toolName: "writeFile",
          });
        };

        const handleEvent = (event) => {
          if (!event || typeof event !== "object") {
            return;
          }

          const tokenCountMetadata = getCodexTokenCountMetadata(event);
          if (tokenCountMetadata) {
            writer.write({
              messageMetadata: {
                ...responseMessageMetadata,
                ...tokenCountMetadata,
              },
              type: "message-metadata",
            });
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
            event.type === "turn.plan.updated" ||
            event.type === "turn/plan/updated" ||
            event.type === "plan.updated" ||
            event.type === "plan.update"
          ) {
            writeCodexTodoListPart(writeEvent, event);
            return;
          }

          if (
            event.type === "response_item" ||
            event.type === "rawResponseItem.completed" ||
            event.type === "rawResponseItem/completed"
          ) {
            writeCodexTodoListPartFromResponseItem(
              writeEvent,
              event.payload ?? event.item ?? event.response_item,
            );
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

          if (event.type === "item.started" && event.item) {
            if (
              writeCodexTodoListPartFromResponseItem(writeEvent, event.item)
            ) {
              return;
            }

            if (event.item.type === "command_execution") {
              ensureCommandToolStarted(event.item);
              return;
            }

            if (isCodexCliFileChangeItem(event.item)) {
              ensureFileToolStarted(event.item);
              return;
            }

            return;
          }

          if (event.type !== "item.completed" || !event.item) {
            return;
          }

          const item = event.item;
          if (writeCodexTodoListPartFromResponseItem(writeEvent, item)) {
            return;
          }

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

          if (isCodexCliFileChangeItem(item)) {
            ensureFileToolStarted(item);
            const outputWrite = buildFileChangeOutput({ item, projectPath })
              .then((output) => {
                if (finished) {
                  return;
                }

                writeEvent({
                  type: "tool-output-available",
                  dynamic: true,
                  output,
                  toolCallId: item.id,
                });
              })
              .finally(() => {
                pendingOutputWrites.delete(outputWrite);
              });
            pendingOutputWrites.add(outputWrite);
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
                cwd: projectPath,
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
                  finishAfterPendingOutputWrites(resolve);
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
