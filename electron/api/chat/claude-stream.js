// The Claude Code translator. Claude runs through an AI SDK provider, so
// its text, reasoning and tool parts arrive as an SDK stream merged into
// the turn; Dream's own concerns (permission prompts, context compaction,
// the session id, usage) go through the turn like every other provider.
import {
  convertToModelMessages,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai";
import { claudeCode, getSessionInfo } from "ai-sdk-provider-claude-code";
import {
  CLAUDE_REASONING_EFFORT_MAP,
  getModelReasoningEfforts,
  normalizeClaudeCodeModel,
} from "../../shared/model-options.js";
import { resolveProjectPath } from "../project-git/files.js";
import { resolveCliCommandPath } from "../shared/cli.js";
import { streamAgentTurn } from "./agent-turn.js";
import {
  BROWSER_MCP_SERVER_NAME,
  BROWSER_READ_ONLY_TOOL_IDS,
  createBrowserMcpServer,
} from "./browser-tools.js";
import {
  buildCodexMessageFilePartsSummary,
  getLatestUserMessage,
} from "./codex-prompt.js";
import { formatStreamError } from "./errors.js";
import { toClaudeMcpServers } from "./mcp-servers.js";
import { shouldResumeProviderSession } from "./provider-session.js";
import {
  DEFAULT_TOOL_STEP_LIMIT,
  REASONING_TOOL_STEP_LIMIT,
} from "./schema.js";

const CLAUDE_PERMISSION_MODE_MAP = {
  ask: "default",
  "auto-accept-edits": "acceptEdits",
  "full-access": "bypassPermissions",
};

const appendClaudeAttachmentTextToLatestUserMessage = (messages) => {
  const latestUserMessage = getLatestUserMessage(messages);
  const attachmentText = buildCodexMessageFilePartsSummary(latestUserMessage);
  if (!latestUserMessage || !attachmentText) {
    return messages;
  }

  const attachmentPrompt = [
    "Current turn attachments:",
    attachmentText,
    "Use these attachment contents as part of the user's latest request.",
  ].join("\n\n");

  return messages.map((message) =>
    message === latestUserMessage
      ? {
          ...message,
          parts: [
            ...(Array.isArray(message.parts) ? message.parts : []),
            {
              text: attachmentPrompt,
              type: "text",
            },
          ],
        }
      : message,
  );
};

const CLAUDE_ACCEPT_EDITS_ALLOWED_TOOLS = new Set([
  "edit",
  "glob",
  "grep",
  "ls",
  "multiedit",
  "notebookedit",
  "read",
  "write",
]);

const CLAUDE_BUILT_IN_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "Bash",
  "BashOutput",
  "KillBash",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "AskUserQuestion",
  "Skill",
];

const CLAUDE_PRELOADED_TOOL_NAMES = new Set(
  CLAUDE_BUILT_IN_TOOLS.map((toolName) => normalizeClaudeToolName(toolName)),
);

// Dream's chat transport is scoped to one request. Claude background agents can
// outlive that request, which closes the UI stream before their completion
// notifications arrive. Keep local subagents attached to the parent turn so
// the request remains open and their results continue streaming to the chat.
export const keepClaudeAgentAttachedToTurn = (toolName, input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  const normalizedToolName = normalizeClaudeToolName(toolName);
  if (normalizedToolName !== "agent" && normalizedToolName !== "task") {
    return input;
  }

  if (input.run_in_background === false) {
    return input;
  }

  return {
    ...input,
    run_in_background: false,
  };
};

// PreToolUse hook wrapper for keepClaudeAgentAttachedToTurn. The canUseTool
// rewrite only runs when the SDK asks for permission. Bypass mode and user
// allow rules can skip that callback; hooks run before permission evaluation.
export const createClaudeAgentAttachmentHook = () => {
  return async (hookInput) => {
    const toolInput = hookInput?.tool_input;
    const attachedInput = keepClaudeAgentAttachedToTurn(
      hookInput?.tool_name,
      toolInput,
    );

    if (attachedInput === toolInput) {
      return { continue: true };
    }

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: attachedInput,
      },
    };
  };
};

// Native file tools whose target paths must stay inside the project root.
const CLAUDE_PATH_GUARDED_TOOLS = new Set([
  "edit",
  "glob",
  "grep",
  "ls",
  "multiedit",
  "notebookedit",
  "read",
  "write",
]);

const CLAUDE_PATH_INPUT_KEYS = [
  "file_path",
  "filePath",
  "notebook_path",
  "notebookPath",
  "path",
];

const getClaudeToolInputPaths = (input) => {
  if (!input || typeof input !== "object") {
    return [];
  }

  return CLAUDE_PATH_INPUT_KEYS.map((key) => input[key]).filter(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
};

const findClaudeBlockedPath = (projectPath, toolName, input) => {
  if (
    !projectPath ||
    !CLAUDE_PATH_GUARDED_TOOLS.has(normalizeClaudeToolName(toolName))
  ) {
    return null;
  }

  for (const candidate of getClaudeToolInputPaths(input)) {
    try {
      resolveProjectPath(projectPath, candidate);
    } catch {
      return candidate;
    }
  }

  return null;
};

const getClaudeToolSearchQuery = (input) => {
  if (typeof input === "string") {
    return input.trim();
  }

  if (!input || typeof input !== "object") {
    return "";
  }

  const value =
    input.query ??
    input.pattern ??
    input.tool ??
    input.toolName ??
    input.tool_name ??
    input.name;
  return typeof value === "string" ? value.trim() : "";
};

const isPreloadedClaudeToolSearch = (input) => {
  const normalizedQuery = normalizeClaudeToolName(
    getClaudeToolSearchQuery(input),
  );
  if (!normalizedQuery) {
    return false;
  }

  for (const preloadedToolName of CLAUDE_PRELOADED_TOOL_NAMES) {
    if (
      normalizedQuery === preloadedToolName ||
      normalizedQuery.includes(preloadedToolName)
    ) {
      return true;
    }
  }

  return false;
};

/**
 * The SDK's `canUseTool` callback: decides locally what the permission mode
 * allows, and asks the user through the turn for everything else.
 */
export const createClaudePermissionHandler = (turn, { mode, projectPath }) => {
  return async (toolName, input, options) => {
    const normalizedToolName = normalizeClaudeToolName(toolName);
    const attachedInput = keepClaudeAgentAttachedToTurn(toolName, input);
    const toolUseID =
      typeof options?.toolUseID === "string" ? options.toolUseID : undefined;

    if (
      normalizedToolName === "toolsearch" &&
      isPreloadedClaudeToolSearch(attachedInput)
    ) {
      return {
        behavior: "deny",
        interrupt: false,
        message:
          "That tool is already preloaded. Use it directly instead of ToolSearch.",
        ...(toolUseID ? { toolUseID } : {}),
      };
    }

    // Invoking a skill only loads its SKILL.md instructions into context. The
    // tools the skill then uses still go through this handler, so the Skill
    // tool itself never needs an approval prompt.
    if (normalizedToolName === "skill") {
      return {
        behavior: "allow",
        ...(toolUseID ? { toolUseID } : {}),
        updatedInput: attachedInput,
      };
    }

    const blockedProjectPath = findClaudeBlockedPath(
      projectPath,
      toolName,
      attachedInput,
    );
    if (blockedProjectPath) {
      return {
        behavior: "deny",
        interrupt: false,
        message: `Path "${blockedProjectPath}" is outside the project root and cannot be accessed.`,
        ...(toolUseID ? { toolUseID } : {}),
      };
    }

    if (
      normalizedToolName !== "askuserquestion" &&
      mode === "accept-edits" &&
      CLAUDE_ACCEPT_EDITS_ALLOWED_TOOLS.has(normalizedToolName)
    ) {
      return {
        behavior: "allow",
        ...(toolUseID ? { toolUseID } : {}),
        updatedInput: attachedInput,
      };
    }

    if (normalizedToolName !== "askuserquestion" && mode === "bypass") {
      return {
        behavior: "allow",
        ...(toolUseID ? { toolUseID } : {}),
        updatedInput: attachedInput,
      };
    }

    const toolCallId =
      typeof options?.toolUseID === "string" && options.toolUseID.length > 0
        ? options.toolUseID
        : `claude-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const title =
      typeof options?.displayName === "string" && options.displayName.length > 0
        ? options.displayName
        : toolName;
    const approvalInput = {
      ...attachedInput,
      ...(typeof options?.title === "string" ? { title: options.title } : {}),
      ...(typeof options?.displayName === "string"
        ? { displayName: options.displayName }
        : {}),
      ...(typeof options?.description === "string"
        ? { description: options.description }
        : {}),
      ...(typeof options?.blockedPath === "string"
        ? { blockedPath: options.blockedPath }
        : {}),
      ...(typeof options?.decisionReason === "string"
        ? { decisionReason: options.decisionReason }
        : {}),
    };

    const response = await turn.approval({
      input: approvalInput,
      request: {
        input: attachedInput,
        options: {
          blockedPath: options?.blockedPath ?? null,
          decisionReason: options?.decisionReason ?? null,
          description: options?.description ?? null,
          displayName: options?.displayName ?? null,
          title: options?.title ?? null,
          toolUseID: toolCallId,
        },
        toolName,
      },
      signal: options?.signal,
      title,
      toolCallId,
      toolName,
    });

    if (response.approved) {
      const questionApproval =
        normalizedToolName === "askuserquestion"
          ? parseAskUserQuestionApproval(response.reason)
          : null;

      if (questionApproval) {
        turn.toolOutput(toolCallId, questionApproval);
      }

      return {
        behavior: "allow",
        ...(response.scope === "session" && options?.suggestions
          ? { updatedPermissions: options.suggestions }
          : {}),
        toolUseID: options?.toolUseID,
        updatedInput: questionApproval
          ? { ...attachedInput, ...questionApproval }
          : attachedInput,
      };
    }

    return {
      behavior: "deny",
      interrupt: false,
      message: response.reason || "User rejected the permission request.",
      toolUseID: options?.toolUseID,
    };
  };
};

function normalizeClaudeToolName(toolName) {
  return String(toolName ?? "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();
}

const parseAskUserQuestionApproval = (reason) => {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(reason);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const answers =
      parsed.answers && typeof parsed.answers === "object"
        ? parsed.answers
        : null;
    const annotations =
      parsed.annotations && typeof parsed.annotations === "object"
        ? parsed.annotations
        : null;

    if (!answers) {
      return null;
    }

    return {
      answers,
      ...(annotations ? { annotations } : {}),
    };
  } catch {
    return null;
  }
};

export const streamClaudeResponse = async ({
  abortSignal,
  permissionMode,
  mcpServers = [],
  messages,
  model,
  modelSpeed,
  projectId,
  projectReferencesPrompt,
  projectPath,
  reasoningEffort,
  remoteConversationId,
  remoteConversationModel,
  remoteConversationModelSpeed,
  remoteConversationProjectPath,
  responseMessageMetadata,
}) => {
  const usesReasoningModel =
    getModelReasoningEfforts("anthropic", model).length > 0;
  const claudePermissionHandlerMode =
    permissionMode === "auto-accept-edits"
      ? "accept-edits"
      : permissionMode === "full-access"
        ? "bypass"
        : "ask";
  const claudeExecutablePath = await resolveCliCommandPath("claude");
  // Dream's built-in browser is exposed as an in-process MCP server so the
  // agent can open tabs, navigate, inspect and interact with the same
  // <webview> tabs the user sees. Absent when there is no project context.
  const browserMcpServer = createBrowserMcpServer({ projectId });
  let resumeSessionId = null;
  if (
    shouldResumeProviderSession({
      model,
      modelSpeed,
      projectPath,
      remoteConversationId,
      remoteConversationModel,
      remoteConversationModelSpeed,
      remoteConversationProjectPath,
    })
  ) {
    try {
      const sessionInfo = await getSessionInfo(remoteConversationId, {
        dir: projectPath,
      });
      if (sessionInfo?.sessionId === remoteConversationId) {
        resumeSessionId = remoteConversationId;
      }
    } catch (error) {
      console.warn(
        "[claude] Stored session could not be inspected; starting a new session.",
        error instanceof Error ? error.message : error,
      );
    }
  }
  const providerFactory = (modelId, turn) => {
    let compactionId = null;
    return claudeCode(normalizeClaudeCodeModel(modelId), {
      ...(claudeExecutablePath
        ? { pathToClaudeCodeExecutable: claudeExecutablePath }
        : {}),
      canUseTool: createClaudePermissionHandler(turn, {
        mode: claudePermissionHandlerMode,
        projectPath,
      }),
      streamingInput: "auto",
      continue: false,
      cwd: projectPath,
      // Dream closes the transport when this request finishes, so background
      // task notifications cannot start another turn. Disable background mode
      // for Bash as well as subagents, including automatic backgrounding of
      // long commands (which the Agent/Task input hook cannot prevent).
      env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
      persistSession: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      hooks: {
        PostCompact: [
          {
            hooks: [
              async () => {
                turn.compaction(
                  compactionId ?? `claude-context-compaction-${Date.now()}`,
                  "compacted",
                );
                compactionId = null;
                return { continue: true };
              },
            ],
          },
        ],
        PreToolUse: [
          {
            matcher: "^(Agent|Task)$",
            hooks: [createClaudeAgentAttachmentHook()],
          },
        ],
        PreCompact: [
          {
            hooks: [
              async () => {
                compactionId = `claude-context-compaction-${Date.now()}`;
                turn.compaction(compactionId, "compacting");
                return { continue: true };
              },
            ],
          },
        ],
      },
      // `tools` controls the catalog shown to the model; `allowedTools` only
      // controls permission. Do not pre-allow tools: Ask must reach canUseTool.
      tools: CLAUDE_BUILT_IN_TOOLS,
      // Skills are discovered from the filesystem via `settingSources`; this
      // lets Claude invoke any of them through the Skill tool.
      skills: "all",
      // Only Dream-managed MCP servers are loaded; strict mode keeps the
      // user's ~/.claude.json and project .mcp.json entries out of scope
      // (users import those explicitly from Settings > MCP servers).
      mcpServers: {
        ...toClaudeMcpServers(mcpServers),
        ...(browserMcpServer
          ? { [BROWSER_MCP_SERVER_NAME]: browserMcpServer }
          : {}),
      },
      // Read-only browser tools (list tabs, snapshot, screenshot, console
      // logs, wait) are pre-allowed like Read/Glob so looking at the page
      // never prompts; every mutating browser tool still reaches canUseTool.
      ...(browserMcpServer ? { allowedTools: BROWSER_READ_ONLY_TOOL_IDS } : {}),
      strictMcpConfig: true,
      // The provider defaults to `settingSources: []`, which isolates the SDK
      // from all filesystem config. Opt in so the user's ~/.claude/settings.json
      // (e.g. attribution overrides), project .claude/ settings, and CLAUDE.md
      // are honored, matching Claude Code CLI behavior.
      settingSources: ["user", "project", "local"],
      permissionMode: CLAUDE_PERMISSION_MODE_MAP[permissionMode] ?? "default",
      ...(permissionMode === "full-access"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(usesReasoningModel
        ? { effort: CLAUDE_REASONING_EFFORT_MAP[reasoningEffort ?? "medium"] }
        : {}),
    });
  };

  let modelMessages;
  try {
    const messagesForModel = resumeSessionId
      ? [getLatestUserMessage(messages)].filter(Boolean)
      : messages;
    modelMessages = await convertToModelMessages(
      appendClaudeAttachmentTextToLatestUserMessage(messagesForModel),
    );
  } catch (err) {
    console.error("[chat] Failed to convert messages:", err);
    const detail =
      err instanceof Error && err.message ? err.message : String(err);
    return new Response(`Failed to prepare messages: ${detail}`, {
      status: 400,
    });
  }

  return streamAgentTurn({
    abortSignal,
    label: "Claude Code",
    messages,
    model,
    modelSpeed,
    projectPath,
    provider: "anthropic",
    responseMessageMetadata,
    execute: (turn) => {
      turn.session(resumeSessionId, { emit: false });
      const textResult = streamText({
        // The turn's own signal (turn-registry.js): Stop aborts the Claude
        // query; a client disconnecting does not.
        abortSignal,
        messages: modelMessages,
        model: providerFactory(model, turn),
        stopWhen: isStepCount(
          usesReasoningModel
            ? REASONING_TOOL_STEP_LIMIT
            : DEFAULT_TOOL_STEP_LIMIT,
        ),
        ...(projectReferencesPrompt
          ? { instructions: projectReferencesPrompt }
          : {}),
      });

      turn.merge(
        toUIMessageStream({
          stream: textResult.stream,
          messageMetadata: ({ part }) => {
            if (part.type === "finish-step") {
              const sessionId =
                part.providerMetadata?.["claude-code"]?.sessionId;
              if (typeof sessionId === "string" && sessionId.trim()) {
                turn.session(sessionId, { emit: false });
                return turn.buildMetadata();
              }
            }

            if (part.type === "finish") {
              return turn.buildMetadata({ usage: part.totalUsage });
            }

            if (part.type === "start") {
              return turn.buildMetadata();
            }

            return undefined;
          },
          onError: (error) => {
            console.error("[chat stream error]", error);
            return formatStreamError(error);
          },
        }),
      );
    },
  });
};
