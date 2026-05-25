import { createOpencode } from "@opencode-ai/sdk";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { waitForToolApproval } from "../tool-approvals.js";
import { writeCodexTextPart } from "./codex-common.js";
import {
  buildCodexConversationPrompt,
  getLatestUserMessage,
  prepareCodexPromptAttachments,
} from "./codex-prompt.js";

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

const isOpenCodeWriteToolPart = (part) =>
  part?.type === "tool" &&
  OPENCODE_WRITE_TOOL_NAMES.has(normalizeOpenCodeToolName(part.tool));

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
    onError: (error) =>
      error instanceof Error ? error.message : "OpenCode request failed.",
    execute: ({ writer }) =>
      new Promise((resolve, reject) => {
        let stderrBuffer = "";
        let finished = false;
        let preparedAttachments = null;
        let textPartIndex = 0;
        let activeSessionId = null;
        const permissionIds = new Set();
        const startedToolCalls = new Set();
        const streamedTextByPartId = new Map();
        let hasWrittenText = false;
        let streamedTextChars = 0;
        let textLimitReached = false;
        let opencode = null;
        const serverAbortController = new AbortController();

        const finish = (callback) => {
          if (finished) return;
          finished = true;
          abortSignal?.removeEventListener("abort", handleAbort);
          serverAbortController.abort();
          preparedAttachments?.cleanup?.();
          opencode?.server.close();
          callback();
        };

        const writeText = (text, idHint, type = "text") => {
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
          writeCodexTextPart(
            (event) => writer.write(event),
            id,
            nextText,
            type,
          );
          streamedTextChars += nextText.length;
          hasWrittenText = true;

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

        const handleWriteToolPart = (part) => {
          if (!isOpenCodeWriteToolPart(part)) {
            return false;
          }

          const toolCallId = part.callID || part.id;
          ensureWriteToolStarted(part);

          const output = getOpenCodeToolOutput(part);
          if (output) {
            writer.write({
              dynamic: true,
              output,
              providerExecuted: true,
              toolCallId,
              type:
                part.state?.status === "error"
                  ? "tool-output-error"
                  : "tool-output-available",
            });
          }

          return true;
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

          if (event.type === "permission.updated") {
            await handlePermission(event.properties);
            return;
          }

          if (event.type !== "message.part.updated") {
            return;
          }

          const part = event.properties?.part;
          if (part?.sessionID !== activeSessionId) {
            return;
          }

          if (handleWriteToolPart(part)) {
            return;
          }

          const text = extractOpenCodePartText(part);
          if (!text) {
            return;
          }

          const id = part.id || `opencode-part-${++textPartIndex}`;
          if (typeof event.properties?.delta === "string") {
            streamedTextByPartId.set(id, text);
            writeText(event.properties.delta, id, getOpenCodePartType(part));
            return;
          }

          const previousText = streamedTextByPartId.get(id) ?? "";
          if (previousText === text) {
            return;
          }

          streamedTextByPartId.set(id, text);
          writeText(
            text.startsWith(previousText)
              ? text.slice(previousText.length)
              : text,
            id,
            getOpenCodePartType(part),
          );
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
            })();

            const promptResult = await opencode.client.session.prompt(
              {
                body: {
                  agent: agentMode === "plan" ? "plan" : "build",
                  model: {
                    modelID,
                    providerID,
                  },
                  parts: [{ text: prompt, type: "text" }],
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

                writeText(text, part.id, getOpenCodePartType(part));
                wroteFallbackText = true;
              }

              if (!wroteFallbackText) {
                throw new Error(
                  "OpenCode completed without returning assistant text.",
                );
              }
            }

            serverAbortController.abort();
            await eventsPromise.catch((error) => {
              if (
                !abortSignal?.aborted &&
                !serverAbortController.signal.aborted
              ) {
                throw error;
              }
            });
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
