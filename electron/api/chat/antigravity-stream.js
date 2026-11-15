import { runAgentCli } from "../providers/agent-cli-run.js";
import {
  assertSafeAntigravityArg,
  getAntigravityCliSpawnErrorMessage,
  getAntigravityPromptInput,
  getAntigravityResultError,
  resolveAntigravityCliLaunch,
  resolveAntigravityEffort,
} from "../providers/antigravity-cli.js";
import { streamAgentTurn } from "./agent-turn.js";
import {
  buildCodexConversationPrompt,
  getLatestUserMessage,
} from "./codex-prompt.js";
import { withSessionHandoff } from "./provider-session.js";
import { applySkillSlashPrefix } from "./skill-dispatch.js";

export const resolveAntigravityContextWindow = (model) => {
  if (typeof model === "string") {
    const lower = model.toLowerCase();
    if (lower.includes("gemini")) return 1_000_000;
    if (lower.includes("claude")) return 200_000;
  }
  return undefined;
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
    resumeSessionId = null,
    sessionHandoff = null,
    responseMessageMetadata,
    skillSlashCommand,
  } = options;

  // Antigravity resumes by conversation ID, with no probe beforehand.
  const targetSessionId = resumeSessionId;

  const prompt = targetSessionId
    ? getAntigravityUserPrompt(
        messages,
        withSessionHandoff(projectReferencesPrompt, sessionHandoff),
      )
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
  } else {
    cliArgs.push("--mode", "plan");
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
  const promptInput = getAntigravityPromptInput(launch, finalPrompt);
  cliArgs.push(...promptInput.args);

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
      turn.session(targetSessionId, {
        emit: false,
        resumed: Boolean(targetSessionId),
      });

      let hasStreamedText = false;

      // A thrown error ends the turn once the CLI exits.
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
            if (update.state === "DONE") {
              turn.closeText();
            }
            return;
          }

          if (update.step_type === "tool") {
            const rawName =
              update.tool_name ?? update.tool_info?.tool_name ?? "tool";
            const toolName =
              String(rawName)
                .replace(/^default_api:/, "")
                .trim() || "tool";
            const toolCallId =
              update.tool_call_id ??
              `antigravity-step-${update.step_index ?? 0}`;
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
              if (
                (toolName === "run_command" || toolName === "runCommand") &&
                update.tool_info?.output === undefined
              ) {
                turn.toolError(toolCallId, "Action was denied (headless mode)");
              } else {
                const output = update.tool_info?.output ?? "Done";
                turn.toolOutput(toolCallId, output);
              }
            } else if (update.state === "ERROR") {
              if (!turn.hasStartedTool(toolCallId)) {
                turn.toolStart({ input, toolCallId, toolName });
              }
              const rawError =
                update.tool_info?.error ??
                update.error ??
                "Antigravity tool failed.";
              const errorText =
                typeof rawError === "object" && rawError !== null
                  ? rawError.message || JSON.stringify(rawError)
                  : String(rawError);
              turn.toolError(toolCallId, errorText);
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
              turn.usage(
                formattedUsage,
                resolveAntigravityContextWindow(model),
              );
            }
          }
          if (!hasStreamedText && typeof result.response === "string") {
            hasStreamedText = true;
            turn.text(result.response);
          }
          if (
            Array.isArray(result.denied_actions) &&
            result.denied_actions.length > 0
          ) {
            for (const [index, action] of result.denied_actions.entries()) {
              const toolCallId = `antigravity-denied-${index}`;
              const actionName =
                action.display_name || action.action || "action";
              turn.toolStart({
                input: action,
                toolCallId,
                toolName: actionName,
              });
              turn.toolError(
                toolCallId,
                `Actions denied by policy: ${actionName}`,
              );
            }
          }
          const resultError = getAntigravityResultError(result);
          if (resultError) {
            throw new Error(resultError);
          }
        }
      };

      // A stop rejects once the process tree is stopped; streamAgentTurn
      // drops errors after the turn was aborted.
      await runAgentCli({
        args: cliArgs,
        cwd: projectPath,
        label: "Antigravity",
        launch,
        onEvent: handleEvent,
        signal: abortSignal,
        spawnErrorMessage: getAntigravityCliSpawnErrorMessage,
        stdin: promptInput.stdin,
      });
    },
  });
};
