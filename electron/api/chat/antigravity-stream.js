import { spawn } from "node:child_process";
import readline from "node:readline";
import { stopChildProcess } from "../../process-tree.js";
import {
  assertSafeAntigravityArg,
  getAntigravityCliSpawnErrorMessage,
  resolveAntigravityCliLaunch,
  resolveAntigravityEffort,
} from "../providers/antigravity-cli.js";
import { streamAgentTurn } from "./agent-turn.js";
import {
  buildCodexConversationPrompt,
  getLatestUserMessage,
} from "./codex-prompt.js";
import { shouldResumeProviderSession } from "./provider-session.js";
import { applySkillSlashPrefix } from "./skill-dispatch.js";

const MAX_STDERR_CHARS = 64_000;
const ANTIGRAVITY_CONTEXT_WINDOW = 1_000_000;

const normalizeAntigravityToolName = (name) => {
  const stripped = String(name ?? "")
    .replace(/^default_api:/, "")
    .trim();
  switch (stripped) {
    case "run_command":
      return "runCommand";
    case "read_file":
      return "readFile";
    case "write_file":
    case "edit_file":
      return "writeFile";
    default:
      return stripped || "tool";
  }
};

const normalizeAntigravityToolInput = (_toolName, params) => {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }

  const normalized = { ...params };
  const filePath = params.Path ?? params.path ?? params.filePath;
  if (filePath) {
    normalized.filePath = filePath;
    normalized.path = filePath;
  }

  if (params.Target !== undefined) {
    normalized.old_string = params.Target;
  }
  if (params.Replacement !== undefined) {
    normalized.new_string = params.Replacement;
  }
  if (params.Content !== undefined) {
    normalized.content = params.Content;
  }
  if (params.CommandLine !== undefined && !params.command) {
    normalized.command = params.CommandLine;
  }

  return normalized;
};

const normalizeAntigravityUsage = (usage) => {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  return {
    cacheReadTokens:
      typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : 0,
    inputTokens:
      typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens:
      typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
    reasoningTokens:
      typeof usage.thinking_tokens === "number" ? usage.thinking_tokens : 0,
  };
};

export const getAntigravityUserPrompt = (
  messages,
  projectReferencesPrompt = null,
) => {
  const latestUserMessage = getLatestUserMessage(messages);
  if (!latestUserMessage) {
    return projectReferencesPrompt ?? "";
  }

  const parts = Array.isArray(latestUserMessage.parts)
    ? latestUserMessage.parts
    : [];
  const textParts = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      const trimmed = part.text.trim();
      if (trimmed) textParts.push(trimmed);
    } else if (part.type === "file") {
      const filename =
        typeof part.filename === "string" && part.filename.trim()
          ? part.filename.trim()
          : typeof part.name === "string" && part.name.trim()
            ? part.name.trim()
            : "file";
      textParts.push(`[File ${filename}]`);
    }
  }

  const userText = textParts.join("\n\n");
  return [userText, projectReferencesPrompt].filter(Boolean).join("\n\n");
};

export const streamAntigravityResponse = async (options) => {
  const {
    abortSignal,
    messages = [],
    model,
    modelSpeed,
    permissionMode = "ask",
    projectPath,
    projectReferencesPrompt,
    reasoningEffort,
    remoteConversationId,
    remoteConversationModel,
    remoteConversationModelSpeed,
    remoteConversationProjectPath,
    resumeSessionId,
    responseMessageMetadata,
    skillSlashCommand,
  } = options;

  const resume = shouldResumeProviderSession({
    model,
    modelSpeed,
    projectPath,
    provider: "antigravity",
    remoteConversationId,
    remoteConversationModel,
    remoteConversationModelSpeed,
    remoteConversationProjectPath,
  });

  const targetSessionId =
    resumeSessionId ?? (resume ? remoteConversationId : null);

  const prompt = targetSessionId
    ? getAntigravityUserPrompt(messages, projectReferencesPrompt)
    : messages.length > 1
      ? buildCodexConversationPrompt({
          currentTurnAttachments: null,
          currentTurnProjectReferences: projectReferencesPrompt,
          messages,
          projectPath,
          runtimeDescription:
            "You are Google Antigravity running inside the Dream desktop IDE with native project tools.",
          systemPrompt:
            "Complete the user's request using the active project when relevant.",
        })
      : getAntigravityUserPrompt(messages, projectReferencesPrompt);

  const finalPrompt = skillSlashCommand
    ? applySkillSlashPrefix(prompt, skillSlashCommand)
    : prompt;

  const cliArgs = ["--output-format", "stream-json"];

  if (permissionMode === "full-access") {
    cliArgs.push("--dangerously-skip-permissions");
  } else if (permissionMode === "auto-accept-edits") {
    cliArgs.push("--mode", "accept-edits");
  }

  if (!skillSlashCommand) {
    cliArgs.push("--disable-slash-commands");
  }

  if (targetSessionId) {
    cliArgs.push("--conversation", targetSessionId);
  }

  if (typeof model === "string" && model.trim()) {
    cliArgs.push("--model", model.trim());
  }

  const effectiveEffort = resolveAntigravityEffort(model, reasoningEffort);
  if (effectiveEffort) {
    cliArgs.push("--effort", effectiveEffort);
  }

  const launch = await resolveAntigravityCliLaunch();
  assertSafeAntigravityArg(launch, model, "model");
  assertSafeAntigravityArg(launch, targetSessionId, "conversation ID");
  const useStdin = Boolean(launch.shell) || finalPrompt.length > 8000;

  if (!useStdin) {
    cliArgs.push("-p", finalPrompt);
  }

  return streamAgentTurn({
    abortSignal,
    label: "Antigravity",
    messages,
    model,
    modelSpeed,
    projectPath,
    provider: "antigravity",
    responseMessageMetadata,
    execute: async (turn) => {
      if (targetSessionId) {
        turn.session(targetSessionId, { emit: false });
      }

      let child;
      try {
        child = spawn(launch.command, [...launch.argsPrefix, ...cliArgs], {
          cwd: projectPath,
          shell: launch.shell,
          stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
        });
        if (useStdin && child.stdin) {
          child.stdin.on("error", () => {});
          child.stdin.end(finalPrompt);
        }
      } catch (error) {
        throw new Error(getAntigravityCliSpawnErrorMessage(error));
      }

      let stderr = "";
      let hasStreamedText = false;
      let exitError = null;

      const onAbort = () => {
        void stopChildProcess(child).catch(() => {});
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
        } else {
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stderr.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
      });

      child.on("error", (error) => {
        exitError = new Error(getAntigravityCliSpawnErrorMessage(error));
      });

      const reader = readline.createInterface({ input: child.stdout });

      const handleEvent = (event) => {
        if (!event || typeof event !== "object") {
          return;
        }

        if (event.event === "init") {
          if (typeof event.conversation_id === "string") {
            turn.session(event.conversation_id);
          }
          return;
        }

        if (event.event === "step_update" && event.step_update) {
          const update = event.step_update;
          if (typeof update.conversation_id === "string") {
            turn.session(update.conversation_id);
          }

          if (update.step_type === "agent_response") {
            if (update.thought_delta) {
              turn.reasoning(update.thought_delta);
            }
            if (update.reasoning_delta) {
              turn.reasoning(update.reasoning_delta);
            }
            if (update.text_delta) {
              hasStreamedText = true;
              turn.text(update.text_delta);
            }
            if (update.usage) {
              const formattedUsage = normalizeAntigravityUsage(update.usage);
              if (formattedUsage) {
                turn.usage(formattedUsage, ANTIGRAVITY_CONTEXT_WINDOW);
              }
            }
            if (update.state === "DONE") {
              turn.closeText();
            }
            return;
          }

          if (update.step_type === "tool") {
            const rawName =
              update.tool_name ?? update.tool_info?.tool_name ?? "tool";
            const toolName = normalizeAntigravityToolName(rawName);
            const toolCallId =
              update.tool_call_id ??
              (update.step_index !== undefined
                ? `antigravity-step-${update.step_index}`
                : `antigravity-tool-${Date.now()}`);
            const input = normalizeAntigravityToolInput(
              rawName,
              update.tool_info?.parameters,
            );

            if (update.state === "ACTIVE") {
              turn.toolStart({ input, toolCallId, toolName });
            } else if (update.state === "DONE") {
              if (!turn.hasStartedTool(toolCallId)) {
                turn.toolStart({ input, toolCallId, toolName });
              }
              const output = update.tool_info?.output ?? "Done";
              turn.toolOutput(toolCallId, output);
            } else if (update.state === "ERROR") {
              if (!turn.hasStartedTool(toolCallId)) {
                turn.toolStart({ input, toolCallId, toolName });
              }
              const errorText =
                update.tool_info?.error ??
                update.error ??
                "Antigravity tool failed.";
              turn.toolError(
                toolCallId,
                typeof errorText === "string"
                  ? errorText
                  : JSON.stringify(errorText),
              );
            }
            return;
          }

          return;
        }

        if (event.event === "result" && event.result) {
          const result = event.result;
          if (typeof result.conversation_id === "string") {
            turn.session(result.conversation_id);
          }
          if (result.usage) {
            const formattedUsage = normalizeAntigravityUsage(result.usage);
            if (formattedUsage) {
              turn.usage(formattedUsage, ANTIGRAVITY_CONTEXT_WINDOW);
            }
          }
          if (!hasStreamedText && typeof result.response === "string") {
            hasStreamedText = true;
            turn.text(result.response);
          }
          if (result.status === "ERROR") {
            throw new Error(
              result.error ?? result.response ?? "Antigravity request failed.",
            );
          }
        }
      };

      reader.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return; // Ignore non-JSON output
        }
        try {
          handleEvent(event);
        } catch (error) {
          exitError ??=
            error instanceof Error ? error : new Error(String(error));
        }
      });

      await new Promise((resolve, reject) => {
        child.on("close", (code) => {
          reader.close();
          if (abortSignal?.removeEventListener) {
            abortSignal.removeEventListener("abort", onAbort);
          }

          if (abortSignal?.aborted) {
            resolve();
            return;
          }

          if (exitError) {
            reject(exitError);
            return;
          }

          if (code !== 0) {
            const detail = stderr.trim();
            reject(
              new Error(detail || `Antigravity CLI exited with code ${code}.`),
            );
            return;
          }

          resolve();
        });
      });
    },
  });
};
