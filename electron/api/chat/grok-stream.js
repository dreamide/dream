import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  authenticateGrokAcp,
  getGrokModelsFromInitializeResult,
  initializeGrokAcp,
  spawnGrokAcp,
} from "../providers/grok-acp.js";
import { waitForToolApproval } from "../tool-approvals.js";
import { writeCodexTodoListPart } from "./codex-common.js";
import {
  buildCodexConversationPrompt,
  getLatestUserMessage,
  getLatestUserPrompt,
  prepareCodexPromptAttachments,
} from "./codex-prompt.js";

const MAX_GROK_TEXT_CHARS = 250_000;

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

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const getFirstString = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
};

const getDreamToolName = (toolCall) => {
  const kind = String(toolCall?.kind ?? "").toLowerCase();
  const title = String(toolCall?.title ?? "").toLowerCase();

  if (["edit", "delete", "move"].includes(kind)) return "writeFile";
  if (kind === "read") return "readFile";
  if (kind === "search") return "searchInFiles";
  if (kind === "execute") return "runCommand";
  if (kind === "fetch") return "webFetch";
  if (title.includes("todo") || title.includes("plan")) return "command";
  return "command";
};

const normalizeToolInput = (toolName, toolCall) => {
  const rawInput = isRecord(toolCall?.rawInput) ? toolCall.rawInput : {};
  const firstLocation = Array.isArray(toolCall?.locations)
    ? toolCall.locations[0]
    : null;
  const path = getFirstString(
    rawInput.path,
    rawInput.filePath,
    rawInput.file_path,
    firstLocation?.path,
  );
  const command = getFirstString(
    rawInput.command,
    rawInput.cmd,
    rawInput.shellCommand,
  );

  return {
    ...rawInput,
    ...(path ? { filePath: path, path } : {}),
    ...(toolName === "runCommand" && command ? { command } : {}),
  };
};

const extractToolOutput = (toolCall) => {
  if (toolCall?.rawOutput !== undefined) return toolCall.rawOutput;
  if (!Array.isArray(toolCall?.content)) return null;

  const parts = toolCall.content.flatMap((entry) => {
    if (entry?.type === "content" && entry.content?.type === "text") {
      return [entry.content.text];
    }
    if (entry?.type === "diff") {
      return [
        {
          newText: entry.newText,
          oldText: entry.oldText ?? null,
          path: entry.path,
          type: "diff",
        },
      ];
    }
    return [];
  });

  if (parts.length === 1) return parts[0];
  return parts;
};

const choosePermissionOption = (options, approved, scope) => {
  const preferredKinds = approved
    ? scope === "session"
      ? ["allow_always", "allow_once"]
      : ["allow_once", "allow_always"]
    : scope === "session"
      ? ["reject_always", "reject_once"]
      : ["reject_once", "reject_always"];

  for (const kind of preferredKinds) {
    const option = options.find((entry) => entry?.kind === kind);
    if (option?.optionId) return option.optionId;
  }
  return options.find((entry) => entry?.optionId)?.optionId ?? null;
};

const shouldLoadRemoteSession = ({
  model,
  projectPath,
  remoteConversationId,
  remoteConversationModel,
  remoteConversationProjectPath,
}) =>
  Boolean(
    remoteConversationId &&
      remoteConversationModel === model &&
      remoteConversationProjectPath === projectPath,
  );

export const streamGrokResponse = ({
  abortSignal,
  agentMode,
  codexPermissionMode,
  messages,
  model,
  projectReferencesPrompt,
  projectPath,
  reasoningEffort,
  remoteConversationId,
  remoteConversationModel,
  remoteConversationProjectPath,
  responseMessageMetadata,
}) => {
  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (error) =>
      error instanceof Error ? error.message : "Grok Build request failed.",
    execute: async ({ writer }) => {
      let connection = null;
      let preparedAttachments = null;
      let sessionId = null;
      let activeTextId = null;
      let activeReasoningId = null;
      let streamedChars = 0;
      let loadingSession = false;
      let loadedSession = false;
      let contextWindow;
      const toolCalls = new Map();
      const completedToolCalls = new Set();

      const writeMetadata = (metadata) =>
        writer.write({ messageMetadata: metadata, type: "message-metadata" });

      const closeTextParts = () => {
        if (activeTextId) {
          writer.write({ id: activeTextId, type: "text-end" });
          activeTextId = null;
        }
        if (activeReasoningId) {
          writer.write({ id: activeReasoningId, type: "reasoning-end" });
          activeReasoningId = null;
        }
      };

      const writeTextDelta = (text, type) => {
        if (!text || abortSignal?.aborted) return;
        const remaining = MAX_GROK_TEXT_CHARS - streamedChars;
        if (remaining <= 0) return;
        const delta = text.slice(0, remaining);
        streamedChars += delta.length;

        if (type === "reasoning") {
          if (activeTextId) {
            writer.write({ id: activeTextId, type: "text-end" });
            activeTextId = null;
          }
          if (!activeReasoningId) {
            activeReasoningId = `grok-reasoning-${Date.now()}`;
            writer.write({ id: activeReasoningId, type: "reasoning-start" });
          }
          writer.write({
            delta,
            id: activeReasoningId,
            type: "reasoning-delta",
          });
          return;
        }

        if (activeReasoningId) {
          writer.write({ id: activeReasoningId, type: "reasoning-end" });
          activeReasoningId = null;
        }
        if (!activeTextId) {
          activeTextId = `grok-text-${Date.now()}`;
          writer.write({ id: activeTextId, type: "text-start" });
        }
        writer.write({ delta, id: activeTextId, type: "text-delta" });
      };

      const ensureToolStarted = (toolCall) => {
        const toolCallId = toolCall?.toolCallId;
        if (!toolCallId) return null;
        const previous = toolCalls.get(toolCallId) ?? {};
        const merged = { ...previous, ...toolCall };
        toolCalls.set(toolCallId, merged);
        if (previous.started) return merged;

        closeTextParts();
        const toolName = getDreamToolName(merged);
        const input = normalizeToolInput(toolName, merged);
        const title = merged.title || "Grok tool";
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
        merged.started = true;
        merged.toolName = toolName;
        merged.input = input;
        return merged;
      };

      const handleToolUpdate = (toolCall) => {
        const merged = ensureToolStarted(toolCall);
        if (!merged?.toolCallId || completedToolCalls.has(merged.toolCallId)) {
          return;
        }
        if (merged.status !== "completed" && merged.status !== "failed") return;

        completedToolCalls.add(merged.toolCallId);
        const output = extractToolOutput(merged);
        if (merged.status === "failed") {
          writer.write({
            dynamic: true,
            errorText:
              getFirstString(merged.rawOutput?.message, merged.rawOutput) ||
              `${merged.title || "Grok tool"} failed.`,
            output,
            providerExecuted: true,
            toolCallId: merged.toolCallId,
            type: "tool-output-error",
          });
          return;
        }

        writer.write({
          dynamic: true,
          output,
          providerExecuted: true,
          toolCallId: merged.toolCallId,
          type: "tool-output-available",
        });
      };

      const handleSessionUpdate = (params) => {
        if (loadingSession || params?.sessionId !== sessionId) return;
        const update = params?.update;
        if (!isRecord(update)) return;

        if (update.sessionUpdate === "agent_message_chunk") {
          writeTextDelta(update.content?.text, "text");
          return;
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
          writeTextDelta(update.content?.text, "reasoning");
          return;
        }
        if (update.sessionUpdate === "plan") {
          writeCodexTodoListPart(
            (event) => writer.write(event),
            update.entries,
          );
          return;
        }
        if (
          update.sessionUpdate === "tool_call" ||
          update.sessionUpdate === "tool_call_update"
        ) {
          handleToolUpdate(update);
        }
      };

      const handlePermissionRequest = async (params) => {
        const toolCall = ensureToolStarted(params?.toolCall ?? {});
        const toolCallId = toolCall?.toolCallId;
        if (!toolCallId) {
          return { outcome: { outcome: "cancelled" } };
        }

        const approvalId = `grok:${sessionId}:${toolCallId}`;
        writer.write({
          approvalId,
          toolCallId,
          type: "tool-approval-request",
        });
        const response = await waitForToolApproval({
          id: approvalId,
          provider: "grok",
          request: {
            input: toolCall.input,
            options: params?.options ?? [],
            toolName: toolCall.toolName,
          },
          signal: abortSignal,
        });

        if (abortSignal?.aborted) {
          return { outcome: { outcome: "cancelled" } };
        }
        const optionId = choosePermissionOption(
          Array.isArray(params?.options) ? params.options : [],
          response.approved,
          response.scope,
        );
        return optionId
          ? { outcome: { optionId, outcome: "selected" } }
          : { outcome: { outcome: "cancelled" } };
      };

      const handleAbort = () => {
        if (!connection) return;
        if (sessionId) {
          connection.notify("session/cancel", { sessionId });
          setTimeout(() => connection?.close(), 250);
          return;
        }
        connection.close();
      };

      const stopIfAborted = () => {
        if (!abortSignal?.aborted) return false;
        handleAbort();
        return true;
      };

      abortSignal?.addEventListener("abort", handleAbort, { once: true });
      writeMetadata(responseMessageMetadata);

      try {
        preparedAttachments = await prepareCodexPromptAttachments(
          getLatestUserMessage(messages),
        );
        if (stopIfAborted()) return;
        connection = await spawnGrokAcp({
          agentMode,
          codexPermissionMode,
          cwd: projectPath,
          model,
          reasoningEffort,
        });
        if (stopIfAborted()) return;
        connection.onNotification = (method, params) => {
          if (method === "session/update") handleSessionUpdate(params);
        };
        connection.onRequest = (method, params) => {
          if (method === "session/request_permission") {
            return handlePermissionRequest(params);
          }
          throw new Error(`Unsupported Grok ACP request: ${method}`);
        };

        const initializeResult = await initializeGrokAcp(connection);
        if (stopIfAborted()) return;
        contextWindow = toFiniteNumber(
          getGrokModelsFromInitializeResult(initializeResult).find(
            (entry) => entry?.modelId === model,
          )?._meta?.totalContextTokens,
        );
        await authenticateGrokAcp(connection, initializeResult);
        if (stopIfAborted()) return;

        const shouldLoad = shouldLoadRemoteSession({
          model,
          projectPath,
          remoteConversationId,
          remoteConversationModel,
          remoteConversationProjectPath,
        });
        if (shouldLoad && initializeResult?.agentCapabilities?.loadSession) {
          sessionId = remoteConversationId;
          loadingSession = true;
          try {
            await connection.request(
              "session/load",
              { cwd: projectPath, mcpServers: [], sessionId },
              60_000,
            );
            if (stopIfAborted()) return;
            loadedSession = true;
          } catch {
            sessionId = null;
          } finally {
            loadingSession = false;
          }
        }

        if (!sessionId) {
          const session = await connection.request("session/new", {
            cwd: projectPath,
            mcpServers: [],
          });
          if (stopIfAborted()) return;
          sessionId = session?.sessionId;
        }
        if (!sessionId) {
          throw new Error("Grok Build did not return a session id.");
        }

        writeMetadata({
          ...responseMessageMetadata,
          remoteConversationId: sessionId,
          remoteConversationModel: model,
          remoteConversationModelSpeed: "standard",
          remoteConversationProjectPath: projectPath,
        });

        const currentTurnAttachments = preparedAttachments?.promptText ?? null;
        const prompt = loadedSession
          ? getLatestUserPrompt(
              messages,
              currentTurnAttachments,
              projectReferencesPrompt,
            )
          : buildCodexConversationPrompt({
              currentTurnAttachments,
              currentTurnProjectReferences: projectReferencesPrompt,
              messages,
              projectPath,
              runtimeDescription:
                "You are Grok Build running inside the Dream desktop IDE with native project tools.",
              systemPrompt:
                "Complete the user's request using the active project when relevant.",
            });

        const promptResult = await connection.request(
          "session/prompt",
          { prompt: [{ text: prompt, type: "text" }], sessionId },
          30 * 60_000,
        );
        const usage = getGrokUsageMetadata(promptResult);
        if (usage) {
          writeMetadata({
            ...responseMessageMetadata,
            ...(contextWindow ? { contextWindow } : {}),
            remoteConversationId: sessionId,
            remoteConversationModel: model,
            remoteConversationModelSpeed: "standard",
            remoteConversationProjectPath: projectPath,
            usage,
          });
        }
      } catch (error) {
        if (!abortSignal?.aborted) throw error;
      } finally {
        closeTextParts();
        abortSignal?.removeEventListener("abort", handleAbort);
        preparedAttachments?.cleanup?.();
        connection?.close();
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
};
