import { createOpencode } from "@opencode-ai/sdk";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { waitForToolApproval } from "../tool-approvals.js";
import { writeCodexTextPart, writeCodexTodoListPart } from "./codex-common.js";
import {
  buildCodexConversationPrompt,
  chunkTextInput,
  getLatestUserMessage,
  prepareCodexPromptAttachments,
} from "./codex-prompt.js";
import { formatStreamError } from "./errors.js";

const OPENCODE_SERVER_TIMEOUT_MS = 10000;
const MAX_OPENCODE_TEXT_CHARS = 250_000;
const OPENCODE_WRITE_TOOL_NAMES = new Set([
  "apply-patch",
  "applypatch",
  "edit",
  "multi-edit",
  "multiedit",
  "notebook-edit",
  "notebookedit",
  "patch",
  "write",
  "write-file",
  "writefile",
]);
const OPENCODE_TODO_TOOL_NAMES = new Set([
  "todo",
  "todo-write",
  "todowrite",
  "todos",
  "update-plan",
  "update-todo",
  "update-todos",
  "updateplan",
  "updatetodo",
  "updatetodos",
]);

const getOpenCodeErrorDetail = (event) => {
  if (!event || typeof event !== "object") {
    return null;
  }

  const values = [
    event.error?.message,
    event.error,
    event.message,
    event.properties?.error?.message,
    event.properties?.error,
  ];

  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
};

const parseOpenCodeModel = (model) => {
  const [providerID, ...modelParts] = String(model ?? "").split("/");
  const modelID = modelParts.join("/");

  if (!providerID || !modelID) {
    throw new Error(
      "OpenCode model must use provider/model format, for example opencode-go/kimi-k2.6.",
    );
  }

  return { modelID, providerID };
};

const getOpenCodeServerConfig = (codexPermissionMode) => {
  if (codexPermissionMode === "full-access") {
    return {
      permission: {
        bash: "allow",
        doom_loop: "allow",
        edit: "allow",
        external_directory: "allow",
        webfetch: "allow",
      },
    };
  }

  if (codexPermissionMode === "auto-accept-edits") {
    return {
      permission: {
        edit: "allow",
      },
    };
  }

  return {};
};

const extractOpenCodePartText = (part) => {
  if (
    (part?.type === "text" || part?.type === "reasoning") &&
    typeof part.text === "string"
  ) {
    return part.text;
  }

  return "";
};

const getOpenCodePartType = (part) =>
  part?.type === "reasoning" ? "reasoning" : "text";

const isLikelySubmittedOpenCodePrompt = (text, prompt) => {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  const normalizedPrompt = typeof prompt === "string" ? prompt.trim() : "";

  if (!normalizedText) {
    return false;
  }

  if (normalizedText === normalizedPrompt) {
    return true;
  }

  return (
    normalizedText.startsWith("You are an expert coding copilot") &&
    normalizedText.includes("Conversation transcript:") &&
    normalizedText.includes("Continue the conversation naturally")
  );
};

const normalizeOpenCodeToolName = (toolName) =>
  String(toolName ?? "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();

const getFirstString = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isOpenCodeWriteToolPart = (part) =>
  part?.type === "tool" &&
  OPENCODE_WRITE_TOOL_NAMES.has(normalizeOpenCodeToolName(part.tool));

const isOpenCodeTodoToolPart = (part) =>
  part?.type === "tool" &&
  OPENCODE_TODO_TOOL_NAMES.has(
    normalizeOpenCodeToolName(part.tool ?? part.name),
  );

const createOpenCodePermissionInput = (permission) => ({
  callID: permission.callID ?? null,
  metadata: permission.metadata ?? {},
  pattern: permission.pattern ?? null,
  title: permission.title ?? "",
  type: permission.type ?? "",
});

const shouldAutoApproveOpenCodePermission = ({
  codexPermissionMode,
  permission,
}) => {
  if (codexPermissionMode === "full-access") {
    return true;
  }

  return (
    codexPermissionMode === "auto-accept-edits" && permission.type === "edit"
  );
};

const replyToOpenCodePermission = async ({
  client,
  directory,
  permission,
  response,
}) => {
  await client.postSessionIdPermissionsPermissionId({
    body: { response },
    path: {
      id: permission.sessionID,
      permissionID: permission.id,
    },
    query: { directory },
  });
};

const getOpenCodeToolStateInput = (part) => {
  const input = part?.state?.input;
  return input && typeof input === "object" ? input : {};
};

const getOpenCodeDreamToolName = (toolName) => {
  const normalized = normalizeOpenCodeToolName(toolName);

  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch")
  ) {
    return "writeFile";
  }

  if (normalized.includes("read")) {
    return "readFile";
  }

  if (
    normalized.includes("webfetch") ||
    normalized.includes("web-fetch") ||
    normalized.includes("web-search") ||
    normalized.includes("fetch")
  ) {
    return "webFetch";
  }

  if (
    normalized.includes("grep") ||
    normalized.includes("search") ||
    normalized.includes("glob") ||
    normalized.includes("find")
  ) {
    return "searchInFiles";
  }

  if (
    normalized.includes("list") ||
    normalized === "ls" ||
    normalized.includes("directory")
  ) {
    return "listFiles";
  }

  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal") ||
    normalized.startsWith("run-")
  ) {
    return "runCommand";
  }

  if (normalized.includes("task") || normalized.includes("agent")) {
    return "agent";
  }

  return "command";
};

const getOpenCodeDreamToolTitle = (dreamToolName) => {
  if (dreamToolName === "writeFile") return "File change";
  if (dreamToolName === "readFile") return "Read file";
  if (dreamToolName === "searchInFiles") return "Search";
  if (dreamToolName === "listFiles") return "List files";
  if (dreamToolName === "runCommand") return "Command";
  if (dreamToolName === "webFetch") return "Web fetch";
  if (dreamToolName === "agent") return "Agent";
  return "Tool";
};

const normalizeOpenCodeToolInput = (dreamToolName, input) => {
  if (!isRecord(input)) {
    return {};
  }

  const path = getFirstString(
    input.path,
    input.filePath,
    input.file_path,
    input.filename,
    input.file,
  );
  const command = getFirstString(input.command, input.cmd, input.shellCommand);
  const query = getFirstString(input.query, input.pattern, input.search);
  const url = getFirstString(input.url, input.uri);

  if (dreamToolName === "readFile" || dreamToolName === "writeFile") {
    return {
      ...input,
      ...(path ? { filePath: path, path } : {}),
    };
  }

  if (dreamToolName === "runCommand") {
    return {
      ...input,
      ...(command ? { command } : {}),
    };
  }

  if (dreamToolName === "searchInFiles") {
    return {
      ...input,
      ...(query ? { pattern: query, query } : {}),
      ...(path ? { path } : {}),
    };
  }

  if (dreamToolName === "listFiles") {
    return {
      ...input,
      ...(path ? { directory: path, path } : {}),
      ...(query ? { pattern: query } : {}),
    };
  }

  if (dreamToolName === "webFetch") {
    return {
      ...input,
      ...(url ? { url } : {}),
    };
  }

  return input;
};

const getOpenCodeOutputText = (part) =>
  typeof part?.state?.output === "string" ? part.state.output : "";

const parseOpenCodeOutputLines = (output) =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const normalizeOpenCodeToolOutput = (part, dreamToolName, input) => {
  const outputText = getOpenCodeOutputText(part);
  const baseOutput = {
    ...part.state.metadata,
    status: "completed",
    title: part.state.title ?? "",
  };

  if (dreamToolName === "readFile") {
    return {
      ...baseOutput,
      content: outputText,
      filePath: input.filePath ?? input.path,
      path: input.path ?? input.filePath,
    };
  }

  if (dreamToolName === "runCommand") {
    return {
      ...baseOutput,
      command: input.command,
      output: outputText,
    };
  }

  if (dreamToolName === "listFiles") {
    const files = parseOpenCodeOutputLines(outputText);
    return {
      ...baseOutput,
      count: files.length,
      files,
      output: outputText,
    };
  }

  if (dreamToolName === "webFetch") {
    return {
      ...baseOutput,
      text: outputText,
    };
  }

  if (dreamToolName === "searchInFiles") {
    return outputText;
  }

  return {
    ...baseOutput,
    output: outputText,
  };
};

const getOpenCodeToolOutput = (part) => {
  if (part?.state?.status === "completed") {
    return {
      ...part.state.metadata,
      output: part.state.output ?? "",
      status: "completed",
      title: part.state.title ?? "",
    };
  }

  if (part?.state?.status === "error") {
    return {
      error: part.state.error ?? "",
      status: "error",
    };
  }

  return null;
};

const getOpenCodeToolErrorText = (part) => {
  const error = part?.state?.error;
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error !== undefined && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return "OpenCode tool failed.";
};

export const streamOpenCodeResponse = ({
  abortSignal,
  agentMode,
  codexPermissionMode,
  messages,
  model,
  projectReferencesPrompt,
  projectPath,
  responseMessageMetadata,
  systemPrompt,
}) => {
  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (error) => formatStreamError(error),
    execute: ({ writer }) =>
      new Promise((resolve, reject) => {
        let stderrBuffer = "";
        let finished = false;
        let preparedAttachments = null;
        let textPartIndex = 0;
        let activeSessionId = null;
        let submittedPrompt = "";
        const permissionIds = new Set();
        const startedToolCalls = new Set();
        const completedToolCalls = new Set();
        const streamedTextByPartId = new Map();
        const messageRoleById = new Map();
        const pendingPartEventsByMessageId = new Map();
        const activeTextParts = new Map();
        const completedTextParts = new Set();
        let hasWrittenText = false;
        let streamedTextChars = 0;
        let textLimitReached = false;
        let opencode = null;
        let eventsError = null;
        const serverAbortController = new AbortController();

        const getTextPartKey = (id, type) => `${type}:${id}`;

        const startTextPart = (id, type) => {
          const key = getTextPartKey(id, type);
          if (completedTextParts.has(key)) {
            return false;
          }

          if (!activeTextParts.has(key)) {
            writer.write({ type: `${type}-start`, id });
            activeTextParts.set(key, { id, type });
          }

          return true;
        };

        const closeTextPart = (id, type) => {
          const key = getTextPartKey(id, type);
          if (!activeTextParts.has(key)) {
            return;
          }

          writer.write({ type: `${type}-end`, id });
          activeTextParts.delete(key);
          completedTextParts.add(key);
        };

        const closeActiveTextParts = () => {
          for (const { id, type } of activeTextParts.values()) {
            writer.write({ type: `${type}-end`, id });
            completedTextParts.add(getTextPartKey(id, type));
          }
          activeTextParts.clear();
        };

        const finish = (callback) => {
          if (finished) return;
          finished = true;
          closeActiveTextParts();
          abortSignal?.removeEventListener("abort", handleAbort);
          serverAbortController.abort();
          preparedAttachments?.cleanup?.();
          opencode?.server.close();
          callback();
        };

        const writeText = (text, idHint, type = "text", end = false) => {
          if (!text || finished || abortSignal?.aborted || textLimitReached) {
            return;
          }
          const remainingChars = MAX_OPENCODE_TEXT_CHARS - streamedTextChars;
          if (remainingChars <= 0) {
            textLimitReached = true;
            finish(resolve);
            return;
          }
          const id = idHint || `opencode-${type}-${++textPartIndex}`;
          const nextText =
            text.length > remainingChars ? text.slice(0, remainingChars) : text;
          if (!startTextPart(id, type)) {
            return;
          }

          writer.write({ type: `${type}-delta`, delta: nextText, id });
          streamedTextChars += nextText.length;
          hasWrittenText = true;

          if (end) {
            closeTextPart(id, type);
          }

          if (nextText.length < text.length) {
            textLimitReached = true;
            writeCodexTextPart(
              (event) => writer.write(event),
              `opencode-output-limit-${++textPartIndex}`,
              `\n\n[OpenCode output stopped after ${MAX_OPENCODE_TEXT_CHARS.toLocaleString()} characters to keep Dream responsive.]`,
              "text",
            );
            finish(resolve);
          }
        };

        const isOpenCodePartFinished = (part) =>
          typeof part?.time?.end === "number" ||
          (part?.type === "tool" &&
            (part.state?.status === "completed" ||
              part.state?.status === "error"));

        const getOpenCodeMessageId = (part) =>
          typeof part?.messageID === "string" && part.messageID.trim()
            ? part.messageID
            : null;

        const queuePendingPartEvent = (messageId, event) => {
          const pendingEvents = pendingPartEventsByMessageId.get(messageId);
          if (pendingEvents) {
            pendingEvents.push(event);
            return;
          }

          pendingPartEventsByMessageId.set(messageId, [event]);
        };

        const handleMessageUpdated = async (message) => {
          if (
            !message ||
            message.sessionID !== activeSessionId ||
            typeof message.id !== "string"
          ) {
            return;
          }

          if (message.role !== "assistant" && message.role !== "user") {
            return;
          }

          messageRoleById.set(message.id, message.role);

          const pendingEvents = pendingPartEventsByMessageId.get(message.id);
          if (!pendingEvents) {
            return;
          }

          pendingPartEventsByMessageId.delete(message.id);
          for (const pendingEvent of pendingEvents) {
            await handleMessagePartUpdated(pendingEvent);
          }
        };

        const ensureWriteToolStarted = (part) => {
          const toolCallId = part?.callID || part?.id;
          if (!toolCallId || startedToolCalls.has(toolCallId)) {
            return;
          }

          startedToolCalls.add(toolCallId);
          writer.write({
            dynamic: true,
            providerExecuted: true,
            title: "File change",
            toolCallId,
            toolName: "writeFile",
            type: "tool-input-start",
          });
          writer.write({
            dynamic: true,
            input: {
              ...getOpenCodeToolStateInput(part),
              title: part.state?.title ?? null,
              tool: part.tool ?? null,
            },
            providerExecuted: true,
            title: "File change",
            toolCallId,
            toolName: "writeFile",
            type: "tool-input-available",
          });
        };

        const ensureOpenCodeToolStarted = ({
          input,
          part,
          title,
          toolName,
        }) => {
          const toolCallId = part?.callID || part?.id;
          if (!toolCallId || startedToolCalls.has(toolCallId)) {
            return;
          }

          startedToolCalls.add(toolCallId);
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
        };

        const handleWriteToolPart = (part) => {
          if (!isOpenCodeWriteToolPart(part)) {
            return false;
          }

          const toolCallId = part.callID || part.id;
          ensureWriteToolStarted(part);

          const output = getOpenCodeToolOutput(part);
          if (output) {
            if (part.state?.status === "error") {
              writer.write({
                dynamic: true,
                errorText: getOpenCodeToolErrorText(part),
                providerExecuted: true,
                toolCallId,
                type: "tool-output-error",
              });
              return true;
            }

            writer.write({
              dynamic: true,
              output,
              providerExecuted: true,
              toolCallId,
              type: "tool-output-available",
            });
          }

          return true;
        };

        const handleGenericToolPart = (part) => {
          if (part?.type !== "tool") {
            return false;
          }

          const toolCallId = part.callID || part.id;
          if (!toolCallId) {
            return false;
          }

          const dreamToolName = getOpenCodeDreamToolName(
            part.tool ?? part.name,
          );
          const input = normalizeOpenCodeToolInput(
            dreamToolName,
            getOpenCodeToolStateInput(part),
          );
          const title =
            part.state?.title ?? getOpenCodeDreamToolTitle(dreamToolName);

          ensureOpenCodeToolStarted({
            input,
            part,
            title,
            toolName: dreamToolName,
          });

          if (
            part.state?.status !== "completed" &&
            part.state?.status !== "error"
          ) {
            return true;
          }

          if (completedToolCalls.has(toolCallId)) {
            return true;
          }

          completedToolCalls.add(toolCallId);
          if (part.state.status === "error") {
            writer.write({
              dynamic: true,
              errorText: getOpenCodeToolErrorText(part),
              providerExecuted: true,
              toolCallId,
              type: "tool-output-error",
            });
            return true;
          }

          writer.write({
            dynamic: true,
            output: normalizeOpenCodeToolOutput(part, dreamToolName, input),
            providerExecuted: true,
            toolCallId,
            type: "tool-output-available",
          });

          return true;
        };

        const handleTodoToolPart = (part) => {
          if (!isOpenCodeTodoToolPart(part)) {
            return false;
          }

          const writeTodoPart = (payload) =>
            writeCodexTodoListPart((event) => writer.write(event), payload);

          return (
            writeTodoPart(part.state?.input) ||
            writeTodoPart(part.state?.structured) ||
            writeTodoPart(part.state?.metadata) ||
            writeTodoPart(part.metadata) ||
            writeTodoPart(part.state?.output)
          );
        };

        const handlePermission = async (permission) => {
          if (
            !permission?.id ||
            permissionIds.has(permission.id) ||
            permission.sessionID !== activeSessionId
          ) {
            return;
          }

          permissionIds.add(permission.id);

          if (
            shouldAutoApproveOpenCodePermission({
              codexPermissionMode,
              permission,
            })
          ) {
            await replyToOpenCodePermission({
              client: opencode.client,
              directory: projectPath,
              permission,
              response: "once",
            });
            return;
          }

          const toolCallId =
            permission.callID || `opencode-permission-${permission.id}`;
          const approvalId = `opencode:${permission.id}`;
          const input = createOpenCodePermissionInput(permission);

          writer.write({
            dynamic: true,
            input,
            providerExecuted: true,
            title: permission.title || "OpenCode permission",
            toolCallId,
            toolName: permission.type || "permission",
            type: "tool-input-start",
          });
          writer.write({
            dynamic: true,
            input,
            providerExecuted: true,
            title: permission.title || "OpenCode permission",
            toolCallId,
            toolName: permission.type || "permission",
            type: "tool-input-available",
          });
          writer.write({
            approvalId,
            toolCallId,
            type: "tool-approval-request",
          });

          const approval = await waitForToolApproval({
            id: approvalId,
            provider: "opencode",
            request: {
              input,
              toolName: permission.type || "permission",
            },
            signal: abortSignal,
          });

          await replyToOpenCodePermission({
            client: opencode.client,
            directory: projectPath,
            permission,
            response: approval.approved
              ? approval.scope === "session"
                ? "always"
                : "once"
              : "reject",
          });
        };

        const handleMessagePartUpdated = async (event) => {
          if (!event || typeof event !== "object") {
            return;
          }

          const part = event.properties?.part;
          if (part?.sessionID !== activeSessionId) {
            return;
          }

          const messageId = getOpenCodeMessageId(part);
          if (messageId) {
            const role = messageRoleById.get(messageId);
            if (role === "user") {
              return;
            }

            if (!role) {
              queuePendingPartEvent(messageId, event);
              return;
            }

            if (role !== "assistant") {
              return;
            }
          }

          if (
            handleTodoToolPart(part) ||
            handleWriteToolPart(part) ||
            handleGenericToolPart(part)
          ) {
            return;
          }

          const text = extractOpenCodePartText(part);
          if (!text) {
            return;
          }

          if (isLikelySubmittedOpenCodePrompt(text, submittedPrompt)) {
            return;
          }

          const id = part.id || `opencode-part-${++textPartIndex}`;
          const type = getOpenCodePartType(part);
          if (typeof event.properties?.delta === "string") {
            streamedTextByPartId.set(id, text);
            writeText(event.properties.delta, id, type);
            if (isOpenCodePartFinished(part)) {
              closeTextPart(id, type);
            }
            return;
          }

          const previousText = streamedTextByPartId.get(id) ?? "";
          if (previousText === text) {
            if (isOpenCodePartFinished(part)) {
              closeTextPart(id, type);
            }
            return;
          }

          streamedTextByPartId.set(id, text);
          writeText(
            text.startsWith(previousText)
              ? text.slice(previousText.length)
              : text,
            id,
            type,
          );
          if (isOpenCodePartFinished(part)) {
            closeTextPart(id, type);
          }
        };

        const handleEvent = async (event) => {
          if (!event || typeof event !== "object") {
            return;
          }

          const detail = getOpenCodeErrorDetail(event);
          if (
            detail &&
            String(event.type ?? "")
              .toLowerCase()
              .includes("error")
          ) {
            stderrBuffer += `${detail}\n`;
            return;
          }

          if (event.type === "message.updated") {
            await handleMessageUpdated(event.properties?.info);
            return;
          }

          if (event.type === "permission.updated") {
            await handlePermission(event.properties);
            return;
          }

          if (event.type === "message.part.updated") {
            await handleMessagePartUpdated(event);
          }
        };

        const handleAbort = () => {
          finish(resolve);
        };

        abortSignal?.addEventListener("abort", handleAbort, { once: true });
        writer.write({
          messageMetadata: responseMessageMetadata,
          type: "message-metadata",
        });

        void prepareCodexPromptAttachments(getLatestUserMessage(messages))
          .then(async (attachments) => {
            preparedAttachments = attachments;
            const prompt = buildCodexConversationPrompt({
              currentTurnAttachments: attachments?.promptText ?? null,
              currentTurnProjectReferences: projectReferencesPrompt,
              messages,
              projectPath,
              runtimeDescription:
                "You are running through the real OpenCode server with native project tools. Respect the active project root and complete the latest user request.",
              systemPrompt,
            });
            submittedPrompt = prompt;

            const { modelID, providerID } = parseOpenCodeModel(model);
            opencode = await createOpencode({
              config: getOpenCodeServerConfig(codexPermissionMode),
              hostname: "127.0.0.1",
              port: 0,
              signal: serverAbortController.signal,
              timeout: OPENCODE_SERVER_TIMEOUT_MS,
            });

            const sessionResult = await opencode.client.session.create({
              body: {
                agent: agentMode === "plan" ? "plan" : "build",
                model: {
                  id: modelID,
                  providerID,
                },
              },
              query: { directory: projectPath },
            });
            activeSessionId = sessionResult.data?.id;

            if (!activeSessionId) {
              throw new Error("OpenCode did not return a session id.");
            }

            const events = await opencode.client.event.subscribe({
              query: { directory: projectPath },
              signal: serverAbortController.signal,
              sseMaxRetryAttempts: 0,
            });

            const eventsPromise = (async () => {
              for await (const event of events.stream) {
                if (finished || abortSignal?.aborted) {
                  return;
                }
                await handleEvent(event);
              }
            })().catch((error) => {
              if (
                !finished &&
                !abortSignal?.aborted &&
                !serverAbortController.signal.aborted
              ) {
                eventsError = error;
                stderrBuffer += `${formatStreamError(error)}\n`;
              }
            });

            const promptResult = await opencode.client.session.prompt(
              {
                body: {
                  agent: agentMode === "plan" ? "plan" : "build",
                  model: {
                    modelID,
                    providerID,
                  },
                  parts: chunkTextInput(prompt).map((text) => ({
                    text,
                    type: "text",
                  })),
                },
                path: { id: activeSessionId },
                query: { directory: projectPath },
              },
              { signal: serverAbortController.signal },
            );

            if (finished || abortSignal?.aborted) {
              return;
            }

            if (!hasWrittenText && !textLimitReached) {
              let wroteFallbackText = false;
              for (const part of promptResult.data?.parts ?? []) {
                const text = extractOpenCodePartText(part);
                if (!text || isLikelySubmittedOpenCodePrompt(text, prompt)) {
                  continue;
                }

                writeText(text, part.id, getOpenCodePartType(part), true);
                wroteFallbackText = true;
              }

              if (!wroteFallbackText) {
                if (eventsError) {
                  throw eventsError;
                }

                throw new Error(
                  "OpenCode completed without returning assistant text.",
                );
              }
            }

            serverAbortController.abort();
            await eventsPromise;
            finish(resolve);
          })
          .catch((error) => {
            finish(() =>
              reject(
                new Error(
                  error instanceof Error
                    ? error.message
                    : stderrBuffer.trim() || "OpenCode request failed.",
                ),
              ),
            );
          });
      }),
  });

  return createUIMessageStreamResponse({ stream });
};
