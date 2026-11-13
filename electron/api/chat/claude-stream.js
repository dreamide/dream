// The Claude Code translator. Claude runs through an AI SDK provider, so
// its text, reasoning and tool parts arrive as an SDK stream merged into
// the turn; Dream's own concerns (permission prompts, context compaction,
// the session id, usage) go through the turn like every other provider.

import path from "node:path";
import {
  convertToModelMessages,
  isStepCount,
  streamText,
  toUIMessageStream,
} from "ai";
import { claudeCode, getSessionInfo } from "ai-sdk-provider-claude-code";
import { saveChatAttachments } from "../../host/chat-attachments.js";
import {
  describeAttachment,
  getAttachmentLabel,
  getMessageFileParts,
  isAttachmentContentInPrompt,
} from "../../shared/attachment-content.js";
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
import { getLatestUserMessage } from "./codex-prompt.js";
import { formatStreamError } from "./errors.js";
import { toClaudeMcpServers } from "./mcp-servers.js";
import { withSessionHandoff } from "./provider-session.js";
import {
  DEFAULT_TOOL_STEP_LIMIT,
  REASONING_TOOL_STEP_LIMIT,
} from "./schema.js";

const CLAUDE_PERMISSION_MODE_MAP = {
  ask: "default",
  "auto-accept-edits": "acceptEdits",
  "full-access": "bypassPermissions",
};

const describeClaudeAttachment = (part, filePath) => {
  const summary = describeAttachment(part);
  if (filePath) return `${summary}\nSaved at: ${filePath}`;
  return isAttachmentContentInPrompt(part)
    ? summary
    : `${summary}\nContents unavailable: only the file name was received. Ask the user to attach it again.`;
};

// The provider forwards only images, so the rest reach the agent as text and
// saved paths. Earlier files are listed every turn: a resumed session is sent
// only this message, and compaction can lose the path it saw before.
const appendClaudeAttachmentTextToLatestUserMessage = (messages, filePaths) => {
  const latestUserMessage = getLatestUserMessage(messages);
  if (!latestUserMessage) return messages;

  const currentParts = getMessageFileParts(latestUserMessage);
  const earlierFiles = new Map();
  for (const [part, filePath] of filePaths) {
    if (!currentParts.includes(part)) {
      earlierFiles.set(filePath, getAttachmentLabel(part));
    }
  }
  const sections = [];
  if (currentParts.length > 0) {
    sections.push(
      "Current turn attachments:",
      currentParts
        .map((part) => describeClaudeAttachment(part, filePaths.get(part)))
        .join("\n\n"),
      "Treat these attachments as part of the user's latest request. Where a saved path is listed, read that file with your tools; a binary format such as a spreadsheet needs a skill or shell command.",
    );
  }
  if (earlierFiles.size > 0) {
    const list = [...earlierFiles]
      .map(([filePath, label]) => `- ${label}: ${filePath}`)
      .join("\n");
    sections.push(
      `Files attached earlier in this chat, to read with your tools if the request needs them:\n${list}`,
    );
  }
  if (sections.length === 0) return messages;

  return messages.map((message) =>
    message === latestUserMessage
      ? {
          ...message,
          parts: [
            ...(Array.isArray(message.parts) ? message.parts : []),
            {
              text: sections.join("\n\n"),
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

// The guarded tools that may also look inside the chat's attachment files.
const CLAUDE_READ_ONLY_PATH_TOOLS = new Set(["glob", "grep", "ls", "read"]);

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

const isInsideDirectory = (directory, absolutePath) => {
  try {
    resolveProjectPath(directory, absolutePath);
    return true;
  } catch {
    return false;
  }
};

const findClaudeBlockedPath = (
  projectPath,
  toolName,
  input,
  readableDirectories,
) => {
  const normalizedToolName = normalizeClaudeToolName(toolName);
  if (!projectPath || !CLAUDE_PATH_GUARDED_TOOLS.has(normalizedToolName)) {
    return null;
  }

  for (const candidate of getClaudeToolInputPaths(input)) {
    // A relative path means the tool's working directory: the project.
    const absolutePath = path.resolve(projectPath, candidate);
    if (isInsideDirectory(projectPath, absolutePath)) continue;
    if (
      CLAUDE_READ_ONLY_PATH_TOOLS.has(normalizedToolName) &&
      readableDirectories.some((directory) =>
        isInsideDirectory(directory, absolutePath),
      )
    ) {
      continue;
    }
    return candidate;
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
export const createClaudePermissionHandler = (
  turn,
  { mode, projectPath, readableDirectories = [] },
) => {
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
      readableDirectories,
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
  chatId,
  permissionMode,
  mcpServers = [],
  messages,
  model,
  modelSpeed,
  projectId,
  projectReferencesPrompt,
  projectPath,
  reasoningEffort,
  resumeSessionId = null,
  sessionHandoff = null,
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
  const { directory: attachmentDirectory, filePaths: attachmentPaths } =
    await saveChatAttachments({ chatId, messages });
  // The session the host said to resume, if Claude Code still has it.
  let resumedSessionId = null;
  let freshReason = null;
  if (resumeSessionId) {
    try {
      const sessionInfo = await getSessionInfo(resumeSessionId, {
        dir: projectPath,
      });
      if (sessionInfo?.sessionId === resumeSessionId) {
        resumedSessionId = resumeSessionId;
      } else {
        freshReason = "Claude Code no longer has the saved session.";
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(
        "[claude] Stored session could not be inspected; starting a new session.",
        detail,
      );
      freshReason = `Claude Code could not inspect the saved session: ${detail}`;
    }
  }
  const instructions = resumedSessionId
    ? withSessionHandoff(projectReferencesPrompt, sessionHandoff)
    : projectReferencesPrompt;
  const providerFactory = (modelId, turn) => {
    let compactionId = null;
    return claudeCode(normalizeClaudeCodeModel(modelId), {
      ...(claudeExecutablePath
        ? { pathToClaudeCodeExecutable: claudeExecutablePath }
        : {}),
      canUseTool: createClaudePermissionHandler(turn, {
        mode: claudePermissionHandlerMode,
        projectPath,
        readableDirectories: attachmentDirectory ? [attachmentDirectory] : [],
      }),
      streamingInput: "auto",
      onSdkMessage: (message) => {
        if (
          message.type === "assistant" &&
          !message.parent_tool_use_id &&
          message.uuid
        )
          turn.metadata({ nativeMessageId: message.uuid });
      },
      continue: false,
      cwd: projectPath,
      ...(attachmentDirectory
        ? { additionalDirectories: [attachmentDirectory] }
        : {}),
      // Dream closes the transport when this request finishes, so background
      // task notifications cannot start another turn. Disable background mode
      // for Bash as well as subagents, including automatic backgrounding of
      // long commands (which the Agent/Task input hook cannot prevent).
      env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
      persistSession: true,
      ...(resumedSessionId ? { resume: resumedSessionId } : {}),
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
    const messagesForModel = resumedSessionId
      ? [getLatestUserMessage(messages)].filter(Boolean)
      : messages;
    modelMessages = await convertToModelMessages(
      appendClaudeAttachmentTextToLatestUserMessage(
        messagesForModel,
        attachmentPaths,
      ),
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
      turn.session(resumedSessionId, {
        emit: false,
        resumed: Boolean(resumedSessionId),
        reason: freshReason,
      });
      const failed = new AbortController();
      const textResult = streamText({
        // The turn's own signal (turn-registry.js): Stop aborts the Claude
        // query; a client disconnecting does not.
        abortSignal: abortSignal
          ? AbortSignal.any([abortSignal, failed.signal])
          : failed.signal,
        messages: modelMessages,
        model: providerFactory(model, turn),
        stopWhen: isStepCount(
          usesReasoningModel
            ? REASONING_TOOL_STEP_LIMIT
            : DEFAULT_TOOL_STEP_LIMIT,
        ),
        ...(instructions ? { instructions } : {}),
      });

      turn.merge(
        toUIMessageStream({
          stream: textResult.stream,
          // The shared turn writer already started this response.
          sendStart: false,
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
        }).pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(chunk);
              if (chunk.type !== "error") return;
              // A terminal error must finish both the client stream and the
              // transcript observer, even if the provider stalls in cleanup.
              controller.terminate();
              failed.abort();
            },
          }),
        ),
      );
    },
  });
};
