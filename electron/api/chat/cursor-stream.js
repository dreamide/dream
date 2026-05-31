import { spawn } from "node:child_process";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import {
  getCursorCliSpawnErrorMessage,
  normalizeCursorCliModel,
  resolveCursorCliLaunch,
} from "../providers/cursor-cli.js";
import {
  getLatestUserMessage,
  prepareCodexPromptAttachments,
  serializeCodexMessage,
} from "./codex-prompt.js";

const MAX_CURSOR_TEXT_CHARS = 250_000;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeToolName = (value) =>
  String(value ?? "")
    .replace(/ToolCall$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();

const getString = (value) => (typeof value === "string" ? value : null);

const getFirstString = (...values) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
};

const getCursorEventSessionId = (event) =>
  getFirstString(event?.session_id, event?.sessionId);

const buildCursorConversationPrompt = ({
  currentTurnAttachments,
  currentTurnProjectReferences,
  messages,
  projectPath,
}) => {
  const latestUserMessage = getLatestUserMessage(messages);
  const previousTranscript = messages
    .filter((message) => message !== latestUserMessage)
    .map(serializeCodexMessage)
    .filter(Boolean)
    .join("\n\n");
  const latestUserPrompt = latestUserMessage
    ? serializeCodexMessage(latestUserMessage)
    : "";

  return [
    "You are Cursor Agent running inside the Dream desktop IDE.",
    `Active project: ${projectPath}`,
    "Complete the latest user request below. Use Cursor's project tools to inspect files, search the repository, and run shell commands when that is useful. Do not answer from generic context when the request asks about this repository or its code.",
    currentTurnProjectReferences,
    currentTurnAttachments,
    previousTranscript
      ? `Previous conversation context, for reference only:\n\n${previousTranscript}`
      : null,
    "Latest user request:",
    latestUserPrompt || "USER:\n[No text request provided]",
  ]
    .filter(Boolean)
    .join("\n\n");
};

const extractCursorAssistantText = (event) => {
  if (!isRecord(event)) {
    return "";
  }

  if (event.type === "result") {
    return getString(event.result) ?? "";
  }

  if (event.type === "assistant" && isRecord(event.message)) {
    const content = event.message.content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          isRecord(part) && part.type === "text" ? getString(part.text) : null,
        )
        .filter(Boolean)
        .join("");
    }

    return getString(event.message.text) ?? "";
  }

  return getFirstString(event.text, event.delta, event.message?.text) ?? "";
};

const extractCursorReasoningText = (event) => {
  if (
    !isRecord(event) ||
    (event.type !== "reasoning" && event.type !== "thinking")
  ) {
    return "";
  }

  return getFirstString(event.text, event.delta, event.summary) ?? "";
};

const unwrapCursorToolOutput = (value) => {
  if (isRecord(value) && "success" in value && value.success !== undefined) {
    return value.success;
  }

  if (isRecord(value) && "error" in value && value.error !== undefined) {
    return value.error;
  }

  return value;
};

const getCursorToolEntries = (event) => {
  if (!isRecord(event) || event.type !== "tool_call") {
    return [];
  }

  const toolCall = event.tool_call ?? event.toolCall;
  if (!isRecord(toolCall)) {
    return [];
  }

  const namedTool = getFirstString(
    toolCall.name,
    toolCall.toolName,
    toolCall.type,
  );
  if (namedTool) {
    return [[namedTool, toolCall]];
  }

  return Object.entries(toolCall).filter(([, value]) => isRecord(value));
};

const getCursorToolCallId = (event, payload, input, fallbackName) =>
  getFirstString(
    event.call_id,
    event.callId,
    payload.call_id,
    payload.callId,
    payload.id,
    input.toolCallId,
    input.tool_call_id,
  ) ??
  `cursor-${fallbackName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const getCursorToolInput = (payload) => {
  if (isRecord(payload.args)) {
    return payload.args;
  }
  if (isRecord(payload.input)) {
    return payload.input;
  }
  if (isRecord(payload.parameters)) {
    return payload.parameters;
  }

  return {};
};

const getCursorToolOutput = (event, payload) =>
  unwrapCursorToolOutput(
    payload.result ?? payload.output ?? event.result ?? event.output ?? null,
  );

const getCursorToolError = (event, payload) => {
  const output =
    payload.result ?? payload.output ?? event.result ?? event.output;
  if (isRecord(output) && output.rejected !== undefined) {
    const rejected = output.rejected;
    if (isRecord(rejected)) {
      return (
        getFirstString(rejected.reason, rejected.command) ??
        "Cursor rejected the tool call."
      );
    }

    return "Cursor rejected the tool call.";
  }
  if (isRecord(output) && output.error !== undefined) {
    return typeof output.error === "string"
      ? output.error
      : JSON.stringify(output.error);
  }

  return getFirstString(payload.error, event.error, event.message);
};

const normalizeCursorToolInput = (dreamToolName, input) => {
  if (!isRecord(input)) {
    return {};
  }

  const path = getFirstString(
    input.path,
    input.filePath,
    input.file_path,
    input.filename,
  );
  const content = getFirstString(
    input.fileText,
    input.file_text,
    input.content,
    input.contents,
    input.text,
  );
  const command = getFirstString(input.command, input.cmd, input.shellCommand);

  if (dreamToolName === "writeFile") {
    return {
      ...input,
      ...(path ? { filePath: path, path } : {}),
      ...(content !== null ? { content } : {}),
    };
  }

  if (dreamToolName === "readFile") {
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

  return input;
};

const getDreamToolName = (cursorToolName) => {
  const normalized = normalizeToolName(cursorToolName);
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("delete")
  ) {
    return "writeFile";
  }

  if (normalized.includes("read")) {
    return "readFile";
  }

  if (
    normalized.includes("grep") ||
    normalized.includes("search") ||
    normalized.includes("glob")
  ) {
    return "searchInFiles";
  }

  if (normalized.includes("list") || normalized === "ls") {
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

  return "command";
};

const getDreamToolTitle = (dreamToolName) => {
  if (dreamToolName === "writeFile") return "File change";
  if (dreamToolName === "readFile") return "Read file";
  if (dreamToolName === "searchInFiles") return "Search";
  if (dreamToolName === "listFiles") return "List files";
  if (dreamToolName === "runCommand") return "Command";
  return "Tool";
};

const shouldResumeCursorSession = ({
  model,
  modelSpeed,
  projectPath,
  remoteConversationId,
  remoteConversationModel,
  remoteConversationModelSpeed,
  remoteConversationProjectPath,
}) =>
  Boolean(
    remoteConversationId &&
      remoteConversationModel === model &&
      (remoteConversationModelSpeed ?? "standard") === modelSpeed &&
      remoteConversationProjectPath === projectPath,
  );

const buildCursorArgs = ({
  codexPermissionMode,
  model,
  modelSpeed,
  prompt,
  projectPath,
  remoteConversationId,
  remoteConversationModel,
  remoteConversationModelSpeed,
  remoteConversationProjectPath,
}) => {
  const args = ["-p", "--trust", "--output-format", "stream-json"];

  if (
    shouldResumeCursorSession({
      model,
      modelSpeed,
      projectPath,
      remoteConversationId,
      remoteConversationModel,
      remoteConversationModelSpeed,
      remoteConversationProjectPath,
    })
  ) {
    args.push(`--resume=${remoteConversationId}`);
  }

  args.push("--model", normalizeCursorCliModel(model));
  if (codexPermissionMode === "default") {
    args.push("--mode", "plan");
  }
  args.push("--force");

  args.push(prompt);
  return args;
};

export const streamCursorResponse = ({
  abortSignal,
  codexPermissionMode,
  messages,
  model,
  modelSpeed,
  projectReferencesPrompt,
  projectPath,
  responseMessageMetadata,
  remoteConversationId,
  remoteConversationModel,
  remoteConversationModelSpeed,
  remoteConversationProjectPath,
}) => {
  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (error) =>
      error instanceof Error ? error.message : "Cursor CLI request failed.",
    execute: ({ writer }) =>
      new Promise((resolve, reject) => {
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let finished = false;
        let preparedAttachments = null;
        let activeTextId = null;
        let activeReasoningId = null;
        let streamedText = "";
        let streamedTextChars = 0;
        let child = null;
        const startedToolCalls = new Set();

        const finishText = () => {
          if (activeTextId) {
            writer.write({ type: "text-end", id: activeTextId });
            activeTextId = null;
          }
          if (activeReasoningId) {
            writer.write({ type: "reasoning-end", id: activeReasoningId });
            activeReasoningId = null;
          }
        };

        const finish = (callback) => {
          if (finished) return;
          finished = true;
          finishText();
          abortSignal?.removeEventListener("abort", handleAbort);
          preparedAttachments?.cleanup?.();
          callback();
        };

        const writeMetadata = (metadata) => {
          writer.write({
            messageMetadata: metadata,
            type: "message-metadata",
          });
        };

        const writeTextDelta = (text, type = "text") => {
          if (!text || finished || abortSignal?.aborted) {
            return;
          }

          const remainingChars = MAX_CURSOR_TEXT_CHARS - streamedTextChars;
          if (remainingChars <= 0) {
            finish(resolve);
            return;
          }

          const delta =
            text.length > remainingChars ? text.slice(0, remainingChars) : text;
          if (type === "reasoning") {
            if (!activeReasoningId) {
              activeReasoningId = `cursor-reasoning-${Date.now()}`;
              writer.write({ type: "reasoning-start", id: activeReasoningId });
            }
            writer.write({
              type: "reasoning-delta",
              delta,
              id: activeReasoningId,
            });
          } else {
            if (!activeTextId) {
              activeTextId = `cursor-text-${Date.now()}`;
              writer.write({ type: "text-start", id: activeTextId });
            }
            writer.write({ type: "text-delta", delta, id: activeTextId });
            streamedText += delta;
          }

          streamedTextChars += delta.length;
          if (text.length > delta.length) {
            finish(resolve);
          }
        };

        const ensureToolStarted = ({ input, title, toolCallId, toolName }) => {
          if (startedToolCalls.has(toolCallId)) {
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

        const handleCursorToolEvent = (event) => {
          for (const [cursorToolName, payload] of getCursorToolEntries(event)) {
            const input = getCursorToolInput(payload);
            const dreamToolName = getDreamToolName(cursorToolName);
            const normalizedInput = normalizeCursorToolInput(
              dreamToolName,
              input,
            );
            const title = getDreamToolTitle(dreamToolName);
            const toolCallId = getCursorToolCallId(
              event,
              payload,
              input,
              normalizeToolName(cursorToolName),
            );

            ensureToolStarted({
              input: normalizedInput,
              title,
              toolCallId,
              toolName: dreamToolName,
            });

            const subtype = String(event.subtype ?? "").toLowerCase();
            const error = getCursorToolError(event, payload);
            const output = getCursorToolOutput(event, payload);
            if (
              subtype.includes("started") ||
              (output === null && !error && !subtype.includes("completed"))
            ) {
              continue;
            }

            if (error) {
              writer.write({
                dynamic: true,
                errorText: error,
                output,
                providerExecuted: true,
                toolCallId,
                type: "tool-output-error",
              });
              continue;
            }

            writer.write({
              dynamic: true,
              output,
              providerExecuted: true,
              toolCallId,
              type: "tool-output-available",
            });
          }
        };

        const handleEvent = (event) => {
          if (!event || typeof event !== "object") {
            return;
          }

          const sessionId = getCursorEventSessionId(event);
          if (sessionId) {
            writeMetadata({
              ...responseMessageMetadata,
              remoteConversationId: sessionId,
              remoteConversationModel: model,
              remoteConversationModelSpeed: modelSpeed,
              remoteConversationProjectPath: projectPath,
            });
          }

          if (event.type === "error") {
            const detail =
              getFirstString(event.message, event.error, event.detail) ??
              "Cursor CLI request failed.";
            stderrBuffer += `${detail}\n`;
            return;
          }

          if (event.type === "tool_call") {
            handleCursorToolEvent(event);
            return;
          }

          const reasoningText = extractCursorReasoningText(event);
          if (reasoningText) {
            writeTextDelta(reasoningText, "reasoning");
            return;
          }

          const text = extractCursorAssistantText(event);
          if (!text) {
            return;
          }

          if (event.type === "result" && streamedText.trim()) {
            return;
          }

          writeTextDelta(text, "text");
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
        writeMetadata(responseMessageMetadata);

        void prepareCodexPromptAttachments(getLatestUserMessage(messages))
          .then((attachments) => {
            preparedAttachments = attachments;
            const prompt = buildCursorConversationPrompt({
              currentTurnAttachments: attachments?.promptText ?? null,
              currentTurnProjectReferences: projectReferencesPrompt,
              messages,
              projectPath,
            });

            return Promise.all([
              resolveCursorCliLaunch(),
              Promise.resolve(prompt),
            ]);
          })
          .then(([launch, prompt]) => {
            const args = buildCursorArgs({
              codexPermissionMode,
              model,
              modelSpeed,
              prompt,
              projectPath,
              remoteConversationId,
              remoteConversationModel,
              remoteConversationModelSpeed,
              remoteConversationProjectPath,
            });

            child = spawn(launch.command, [...launch.argsPrefix, ...args], {
              cwd: projectPath,
              env: process.env,
              shell: launch.shell ?? false,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            });

            child.stdout.on("data", handleStdoutChunk);
            child.stderr.on("data", (chunk) => {
              stderrBuffer += chunk.toString();
            });
            child.on("error", (error) => {
              finish(() =>
                reject(new Error(getCursorCliSpawnErrorMessage(error))),
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

              finish(() =>
                reject(
                  new Error(
                    stderrBuffer.trim() ||
                      `Cursor CLI exited with code ${code}.`,
                  ),
                ),
              );
            });
          })
          .catch((error) => {
            finish(() =>
              reject(
                new Error(
                  error instanceof Error
                    ? error.message
                    : "Cursor CLI request failed.",
                ),
              ),
            );
          });
      }),
  });

  return createUIMessageStreamResponse({ stream });
};
