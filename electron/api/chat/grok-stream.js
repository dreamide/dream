import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  applyAmpSessionOptions,
  initializeAmpAcp,
  spawnAmpAcp,
} from "../providers/amp-acp.js";
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
const GROK_TEXT_FLUSH_INTERVAL_MS = 50;

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
  const acpToolName = title.split(":", 1)[0].trim();

  if (acpToolName.startsWith("mcp__")) return acpToolName;
  if (["edit", "delete", "move"].includes(kind)) return "writeFile";
  if (kind === "read") return "readFile";
  if (kind === "search") return "searchInFiles";
  if (kind === "execute") return "runCommand";
  if (kind === "fetch") return "webFetch";
  if (acpToolName === "shell_command") return "runCommand";
  if (acpToolName === "apply_patch") return "writeFile";
  if (acpToolName === "read_web_page") return "webFetch";
  if (acpToolName === "web_search") return "webSearch";
  if (acpToolName === "finder") return "searchInFiles";
  if (title.includes("todo") || title.includes("plan")) return "command";
  return acpToolName || "command";
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

export const parseAcpToolOutput = (value, toolName) => {
  if (typeof value !== "string" || toolName === "readFile") return value;

  try {
    const parsed = JSON.parse(value);
    if (
      toolName === "skill" &&
      isRecord(parsed) &&
      Array.isArray(parsed.content)
    ) {
      const text = parsed.content
        .flatMap((entry) =>
          entry?.type === "text" && typeof entry.text === "string"
            ? [entry.text]
            : [],
        )
        .join("\n");
      if (text) return text;
    }
    if (
      toolName === "webSearch" &&
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (entry) =>
          isRecord(entry) &&
          typeof entry.title === "string" &&
          typeof entry.url === "string",
      )
    ) {
      return parsed
        .map((entry) => {
          const excerpts = Array.isArray(entry.excerpts)
            ? entry.excerpts.filter((excerpt) => typeof excerpt === "string")
            : [];
          return [`[${entry.title}](${entry.url})`, ...excerpts].join("\n\n");
        })
        .join("\n\n---\n\n");
    }
    if (
      isRecord(parsed) &&
      ((toolName === "runCommand" &&
        (typeof parsed.output === "string" ||
          typeof parsed.stdout === "string" ||
          typeof parsed.stderr === "string")) ||
        (toolName === "writeFile" &&
          typeof parsed.summary === "string" &&
          Array.isArray(parsed.files)))
    ) {
      return parsed;
    }
    return value;
  } catch {
    return value;
  }
};

const extractToolOutput = (toolCall) => {
  if (toolCall?.rawOutput != null) {
    return parseAcpToolOutput(toolCall.rawOutput, toolCall.toolName);
  }
  if (!Array.isArray(toolCall?.content)) return null;

  const parts = toolCall.content.flatMap((entry) => {
    if (entry?.type === "content" && entry.content?.type === "text") {
      return [parseAcpToolOutput(entry.content.text, toolCall.toolName)];
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

const streamAcpResponse = ({
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
  provider = "grok",
}) => {
  const isAmp = provider === "amp";
  const providerLabel = isAmp ? "Amp" : "Grok Build";
  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (error) =>
      error instanceof Error
        ? error.message
        : `${providerLabel} request failed.`,
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
      let pendingText = "";
      let pendingTextType = null;
      let pendingTextTimer = null;
      const toolCalls = new Map();
      const completedToolCalls = new Set();

      const writeMetadata = (metadata) =>
        writer.write({ messageMetadata: metadata, type: "message-metadata" });

      const writeTextDeltaNow = (text, type) => {
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
            activeReasoningId = `${provider}-reasoning-${Date.now()}`;
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
          activeTextId = `${provider}-text-${Date.now()}`;
          writer.write({ id: activeTextId, type: "text-start" });
        }
        writer.write({ delta, id: activeTextId, type: "text-delta" });
      };

      const flushPendingText = () => {
        if (pendingTextTimer !== null) {
          clearTimeout(pendingTextTimer);
          pendingTextTimer = null;
        }
        if (!pendingText || !pendingTextType) return;

        const text = pendingText;
        const type = pendingTextType;
        pendingText = "";
        pendingTextType = null;
        writeTextDeltaNow(text, type);
      };

      const closeTextParts = () => {
        flushPendingText();
        if (activeTextId) {
          writer.write({ id: activeTextId, type: "text-end" });
          activeTextId = null;
        }
        if (activeReasoningId) {
          writer.write({ id: activeReasoningId, type: "reasoning-end" });
          activeReasoningId = null;
        }
      };

      const queueTextDelta = (text, type) => {
        if (!text || abortSignal?.aborted) return;
        if (pendingTextType && pendingTextType !== type) {
          flushPendingText();
        }
        pendingTextType = type;
        pendingText += text;
        if (pendingTextTimer === null) {
          pendingTextTimer = setTimeout(
            flushPendingText,
            GROK_TEXT_FLUSH_INTERVAL_MS,
          );
        }
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
        const title = merged.title || `${providerLabel} tool`;
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
          const outputError =
            getFirstString(output?.message, output) ||
            (Array.isArray(output)
              ? output.filter((entry) => typeof entry === "string").join("\n")
              : null);
          writer.write({
            dynamic: true,
            errorText:
              outputError ||
              `${merged.title || `${providerLabel} tool`} failed.`,
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
          queueTextDelta(update.content?.text, "text");
          return;
        }
        if (update.sessionUpdate === "agent_thought_chunk") {
          queueTextDelta(update.content?.text, "reasoning");
          return;
        }
        if (update.sessionUpdate === "plan") {
          flushPendingText();
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
          flushPendingText();
          handleToolUpdate(update);
        }
      };

      const handlePermissionRequest = async (params) => {
        const toolCall = ensureToolStarted(params?.toolCall ?? {});
        const toolCallId = toolCall?.toolCallId;
        if (!toolCallId) {
          return { outcome: { outcome: "cancelled" } };
        }

        const options = Array.isArray(params?.options) ? params.options : [];
        const autoApprove =
          codexPermissionMode === "full-access" ||
          (codexPermissionMode === "auto-accept-edits" &&
            toolCall.toolName === "writeFile");
        if (autoApprove) {
          const optionId = choosePermissionOption(options, true, "once");
          return optionId
            ? { outcome: { optionId, outcome: "selected" } }
            : { outcome: { outcome: "cancelled" } };
        }

        const approvalId = `${provider}:${sessionId}:${toolCallId}`;
        writer.write({
          approvalId,
          toolCallId,
          type: "tool-approval-request",
        });
        const response = await waitForToolApproval({
          id: approvalId,
          provider,
          request: {
            input: toolCall.input,
            options,
            toolName: toolCall.toolName,
          },
          signal: abortSignal,
        });

        if (abortSignal?.aborted) {
          return { outcome: { outcome: "cancelled" } };
        }
        const optionId = choosePermissionOption(
          options,
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
        if (isAmp && agentMode === "plan") {
          throw new Error(
            "Amp ACP does not support Dream's read-only Plan mode. Switch this chat to Build mode.",
          );
        }
        preparedAttachments = await prepareCodexPromptAttachments(
          getLatestUserMessage(messages),
        );
        if (stopIfAborted()) return;
        connection = isAmp
          ? await spawnAmpAcp({ cwd: projectPath })
          : await spawnGrokAcp({
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
          throw new Error(
            `Unsupported ${providerLabel} ACP request: ${method}`,
          );
        };

        const initializeResult = isAmp
          ? await initializeAmpAcp(connection)
          : await initializeGrokAcp(connection);
        if (stopIfAborted()) return;
        if (!isAmp) {
          contextWindow = toFiniteNumber(
            getGrokModelsFromInitializeResult(initializeResult).find(
              (entry) => entry?.modelId === model,
            )?._meta?.totalContextTokens,
          );
        }
        if (!isAmp) await authenticateGrokAcp(connection, initializeResult);
        if (stopIfAborted()) return;

        const shouldLoad =
          !isAmp &&
          shouldLoadRemoteSession({
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
          if (isAmp && sessionId) {
            await applyAmpSessionOptions(connection, session, {
              codexPermissionMode,
              model,
              reasoningEffort,
            });
            if (stopIfAborted()) return;
          }
        }
        if (!sessionId) {
          throw new Error(`${providerLabel} did not return a session id.`);
        }

        if (!isAmp) {
          writeMetadata({
            ...responseMessageMetadata,
            remoteConversationId: sessionId,
            remoteConversationModel: model,
            remoteConversationModelSpeed: "standard",
            remoteConversationProjectPath: projectPath,
          });
        }

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
              runtimeDescription: `You are ${providerLabel} running inside the Dream desktop IDE with native project tools.`,
              systemPrompt:
                "Complete the user's request using the active project when relevant.",
            });

        if (stopIfAborted()) return;
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
            ...(!isAmp
              ? {
                  remoteConversationId: sessionId,
                  remoteConversationModel: model,
                  remoteConversationModelSpeed: "standard",
                  remoteConversationProjectPath: projectPath,
                }
              : {}),
            usage,
          });
        }
      } catch (error) {
        if (!abortSignal?.aborted) {
          if (connection && sessionId) {
            connection.notify("session/cancel", { sessionId });
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          throw error;
        }
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

export const streamGrokResponse = (options) =>
  streamAcpResponse({ ...options, provider: "grok" });

export const streamAmpResponse = (options) =>
  streamAcpResponse({ ...options, provider: "amp" });
