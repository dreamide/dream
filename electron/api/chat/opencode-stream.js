import { spawn } from "node:child_process";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { writeCodexTextPart } from "./codex-common.js";
import {
  buildCodexConversationPrompt,
  getLatestUserMessage,
  prepareCodexPromptAttachments,
} from "./codex-prompt.js";

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

const extractOpenCodeText = (event) => {
  if (!event || typeof event !== "object" || event.type !== "text") {
    return "";
  }

  if (event.part?.type === "text" && typeof event.part.text === "string") {
    return event.part.text;
  }

  return "";
};

const buildOpenCodeRunArgs = ({
  agentMode,
  codexPermissionMode,
  model,
  projectPath,
}) => [
  "run",
  "--format",
  "json",
  "--dir",
  projectPath,
  "--model",
  model,
  "--agent",
  agentMode === "plan" ? "plan" : "build",
  ...(codexPermissionMode === "full-access"
    ? ["--dangerously-skip-permissions"]
    : []),
];

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
      error instanceof Error ? error.message : "OpenCode CLI request failed.",
    execute: ({ writer }) =>
      new Promise((resolve, reject) => {
        let stdoutBuffer = "";
        let stderrBuffer = "";
        let finished = false;
        let preparedAttachments = null;
        let textPartIndex = 0;
        const streamedTextByEventId = new Map();
        const fallbackTexts = [];
        let hasWrittenText = false;
        let child;

        const finish = (callback) => {
          if (finished) return;
          finished = true;
          abortSignal?.removeEventListener("abort", handleAbort);
          preparedAttachments?.cleanup?.();
          callback();
        };

        const writeText = (text, idHint) => {
          if (!text) {
            return;
          }
          const id = idHint || `opencode-text-${++textPartIndex}`;
          writeCodexTextPart((event) => writer.write(event), id, text, "text");
          hasWrittenText = true;
        };

        const handleEvent = (event) => {
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

          const text = extractOpenCodeText(event);
          if (!text) {
            return;
          }

          fallbackTexts.push(text);
          const eventId =
            typeof event.id === "string"
              ? event.id
              : typeof event.part?.id === "string"
                ? event.part.id
                : typeof event.properties?.id === "string"
                  ? event.properties.id
                  : "";
          if (eventId) {
            const previousText = streamedTextByEventId.get(eventId) ?? "";
            if (previousText === text) {
              return;
            }

            if (previousText && text.startsWith(previousText)) {
              const deltaText = text.slice(previousText.length);
              streamedTextByEventId.set(eventId, text);
              writeText(deltaText);
              return;
            }

            streamedTextByEventId.set(eventId, `${previousText}${text}`);
          }
          writeText(text, eventId || undefined);
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
              fallbackTexts.push(trimmed);
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

        void prepareCodexPromptAttachments(getLatestUserMessage(messages))
          .then((attachments) => {
            preparedAttachments = attachments;
            const prompt = buildCodexConversationPrompt({
              currentTurnAttachments: attachments?.promptText ?? null,
              currentTurnProjectReferences: projectReferencesPrompt,
              messages,
              projectPath,
              runtimeDescription:
                "You are running through the real OpenCode CLI with native project tools. Respect the active project root and complete the latest user request.",
              systemPrompt,
            });
            const args = buildOpenCodeRunArgs({
              agentMode,
              codexPermissionMode,
              model,
              projectPath,
            });

            child = spawn("opencode", args, {
              cwd: projectPath,
              env: process.env,
              shell: process.platform === "win32",
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
            });

            child.stdin.end(prompt);
            child.stdout.on("data", handleStdoutChunk);
            child.stderr.on("data", (chunk) => {
              stderrBuffer += chunk.toString();
            });
            child.on("error", (error) => {
              finish(() =>
                reject(
                  new Error(
                    error instanceof Error
                      ? error.message
                      : "OpenCode CLI request failed.",
                  ),
                ),
              );
            });
            child.on("close", (code) => {
              const trimmed = stdoutBuffer.trim();
              if (trimmed) {
                try {
                  handleEvent(JSON.parse(trimmed));
                } catch {
                  fallbackTexts.push(trimmed);
                }
              }

              if (code === 0 || abortSignal?.aborted) {
                if (!hasWrittenText) {
                  writeText(fallbackTexts.join("\n").trim());
                }
                finish(resolve);
                return;
              }

              finish(() =>
                reject(
                  new Error(
                    stderrBuffer.trim() ||
                      `OpenCode CLI exited with code ${code}.`,
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
                    : "Failed to prepare OpenCode prompt.",
                ),
              ),
            );
          });
      }),
  });

  return createUIMessageStreamResponse({ stream });
};
