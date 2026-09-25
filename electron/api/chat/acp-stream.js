import path from "node:path";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { waitForToolApproval } from "../tool-approvals.js";
import { writeCodexTodoListPart } from "./codex-common.js";
import {
  buildCodexConversationPrompt,
  getLatestUserMessage,
  getLatestUserPrompt,
  prepareCodexPromptAttachments,
} from "./codex-prompt.js";
import { toAcpMcpServers } from "./mcp-servers.js";
import { shouldResumeProviderSession } from "./provider-session.js";
import { applySkillSlashPrefix } from "./skill-dispatch.js";

const MAX_ACP_TEXT_CHARS = 250_000;
const ACP_TEXT_FLUSH_INTERVAL_MS = 50;

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
    const option = options.find(
      (entry) => entry?.kind?.replaceAll("-", "_") === kind,
    );
    if (option?.optionId) return option.optionId;
  }
  return null;
};

// Only grant edit requests with known paths inside the active workspace.
const isWorkspaceEdit = (toolCall, projectPath) => {
  if (toolCall.toolName !== "writeFile") return false;
  const paths = [
    ...(toolCall.locations ?? []).map((location) => location.path),
    toolCall.input?.path,
    toolCall.input?.filePath,
  ].filter((value) => typeof value === "string" && value.length > 0);
  return (
    paths.length > 0 &&
    paths.every((filePath) => {
      const relative = path.relative(
        projectPath,
        path.resolve(projectPath, filePath),
      );
      return (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    })
  );
};

export const streamAcpResponse = ({
  adapter,
  modelSpeed = "standard",
  abortSignal,
  permissionMode,
  mcpServers = [],
  messages,
  model,
  projectReferencesPrompt,
  projectPath,
  reasoningEffort,
  remoteConversationId,
  remoteConversationModel,
  remoteConversationModelSpeed,
  remoteConversationProjectPath,
  responseMessageMetadata,
  skillSlashCommand,
}) => {
  const { provider, label } = adapter;
  const acpMcpServers = toAcpMcpServers(mcpServers);
  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (error) =>
      error instanceof Error ? error.message : `${label} request failed.`,
    execute: async ({ writer }) => {
      let connection = null;
      let preparedAttachments = null;
      let sessionId = null;
      let activeTextId = null;
      let activeReasoningId = null;
      let streamedChars = 0;
      let loadingSession = false;
      let loadedSession = false;
      let sessionState;
      const approvalController = new AbortController();
      let pendingText = "";
      let pendingTextType = null;
      let pendingTextTimer = null;
      const toolCalls = new Map();
      const completedToolCalls = new Set();

      const writeMetadata = (metadata) =>
        writer.write({ messageMetadata: metadata, type: "message-metadata" });

      const writeTextDeltaNow = (text, type) => {
        if (!text || abortSignal?.aborted) return;
        const remaining = MAX_ACP_TEXT_CHARS - streamedChars;
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
            ACP_TEXT_FLUSH_INTERVAL_MS,
          );
        }
      };

      const ensureToolStarted = (toolCall) => {
        const toolCallId = toolCall?.toolCallId;
        if (!toolCallId) return null;
        const previous = toolCalls.get(toolCallId) ?? {};
        const merged = { ...previous, ...toolCall };
        toolCalls.set(toolCallId, merged);
        if (previous.started) {
          merged.toolName = getDreamToolName(merged);
          merged.input = normalizeToolInput(merged.toolName, merged);
          return merged;
        }

        closeTextParts();
        const toolName = getDreamToolName(merged);
        const input = normalizeToolInput(toolName, merged);
        const title = merged.title || `${label} tool`;
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
              `${merged.title || `${label} tool`} failed.`,
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
        if (
          approvalController.signal.aborted ||
          loadingSession ||
          params?.sessionId !== sessionId
        ) {
          return { outcome: { outcome: "cancelled" } };
        }
        const toolCall = ensureToolStarted(params?.toolCall ?? {});
        const toolCallId = toolCall?.toolCallId;
        if (!toolCallId) {
          return { outcome: { outcome: "cancelled" } };
        }

        const options = Array.isArray(params?.options) ? params.options : [];
        const autoApprove =
          permissionMode === "full-access" ||
          (permissionMode === "auto-accept-edits" &&
            isWorkspaceEdit(toolCall, projectPath));
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
          signal: approvalController.signal,
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
        approvalController.abort();
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
        connection = await adapter.spawn({
          permissionMode,
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
          return (
            adapter.onRequest?.({
              method,
              params,
              writer,
              sessionId,
              signal: approvalController.signal,
            }) ??
            Promise.reject(
              new Error(`Unsupported ${label} ACP request: ${method}`),
            )
          );
        };

        const initializeResult = await connection.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "dream", version: "1" },
        });
        if (stopIfAborted()) return;
        await adapter.authenticate(connection, initializeResult);
        if (stopIfAborted()) return;

        const shouldLoad = shouldResumeProviderSession({
          modelSpeed,
          remoteConversationModelSpeed,
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
            sessionState = await connection.request(
              "session/load",
              { cwd: projectPath, mcpServers: acpMcpServers, sessionId },
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
            mcpServers: acpMcpServers,
          });
          if (stopIfAborted()) return;
          sessionId = session?.sessionId;
          sessionState = session;
        }
        if (!sessionId) {
          throw new Error(`${label} did not return a session id.`);
        }

        await adapter.configureSession?.(connection, {
          sessionId,
          sessionState,
          model,
          permissionMode,
        });
        if (stopIfAborted()) return;

        writeMetadata({
          ...responseMessageMetadata,
          remoteConversationId: sessionId,
          remoteConversationModel: model,
          remoteConversationModelSpeed: modelSpeed,
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
              runtimeDescription: `You are ${label} running inside the Dream desktop IDE with native project tools.`,
              systemPrompt:
                "Complete the user's request using the active project when relevant.",
            });

        // A `$skill` mention becomes the agent's own `/name` slash command,
        // which it only recognizes at the start of the prompt.
        const dispatchedPrompt = applySkillSlashPrefix(
          prompt,
          skillSlashCommand,
        );

        const promptResult = await connection.request(
          "session/prompt",
          { prompt: [{ text: dispatchedPrompt, type: "text" }], sessionId },
          30 * 60_000,
        );
        const usage = adapter.getUsage?.(promptResult);
        const contextWindow = adapter.getContextWindow?.(
          initializeResult,
          model,
        );
        if (usage) {
          writeMetadata({
            ...responseMessageMetadata,
            remoteConversationId: sessionId,
            remoteConversationModel: model,
            remoteConversationModelSpeed: modelSpeed,
            remoteConversationProjectPath: projectPath,
            ...(contextWindow ? { contextWindow } : {}),
            usage,
          });
        }
      } catch (error) {
        if (!abortSignal?.aborted) throw error;
      } finally {
        approvalController.abort();
        closeTextParts();
        abortSignal?.removeEventListener("abort", handleAbort);
        preparedAttachments?.cleanup?.();
        connection?.close();
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
};
