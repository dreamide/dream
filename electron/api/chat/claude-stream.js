import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
} from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";
import {
  CLAUDE_REASONING_EFFORT_MAP,
  getModelReasoningEfforts,
  normalizeClaudeCodeModel,
} from "../providers/model-options.js";
import { waitForToolApproval } from "../tool-approvals.js";
import { formatStreamError } from "./errors.js";
import { createClaudeProjectTools } from "./project-tools.js";
import {
  DEFAULT_TOOL_STEP_LIMIT,
  REASONING_TOOL_STEP_LIMIT,
  SYSTEM_PROMPT,
} from "./schema.js";

const CLAUDE_PERMISSION_MODE_MAP = {
  "ask-permissions": "default",
  "accept-edits": "acceptEdits",
  "bypass-permissions": "bypassPermissions",
};

const isClaudeImageMediaType = (mediaType) =>
  typeof mediaType === "string" &&
  mediaType.trim().toLowerCase().startsWith("image/");

const isImageDataUrl = (value) =>
  typeof value === "string" && /^data:image\/[^;,]+(?:;[^,]*)?,/i.test(value);

const normalizeClaudeImageInputs = (modelMessages) => {
  let hasImageInput = false;
  let changed = false;

  const normalizedMessages = modelMessages.map((message) => {
    if (!Array.isArray(message.content)) {
      return message;
    }

    let changedContent = false;
    const content = message.content.map((part) => {
      if (part?.type === "image") {
        hasImageInput = true;
        return part;
      }

      if (
        part?.type === "file" &&
        isClaudeImageMediaType(part.mediaType ?? part.mimeType)
      ) {
        hasImageInput = true;

        if (isImageDataUrl(part.data)) {
          changed = true;
          changedContent = true;
          return {
            image: part.data,
            type: "image",
          };
        }
      }

      return part;
    });

    return changedContent ? { ...message, content } : message;
  });

  return {
    hasImageInput,
    messages: changed ? normalizedMessages : modelMessages,
  };
};

const createClaudeNativePermissionHandler = (writer) => {
  return async (toolName, input, options) => {
    const toolCallId =
      typeof options?.toolUseID === "string" && options.toolUseID.length > 0
        ? options.toolUseID
        : `claude-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const approvalId = `anthropic:${toolCallId}`;
    const title =
      typeof options?.displayName === "string" && options.displayName.length > 0
        ? options.displayName
        : toolName;
    const approvalInput = {
      ...input,
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
      input: approvalInput,
      providerExecuted: true,
      title,
      toolCallId,
      toolName,
      type: "tool-input-available",
    });
    writer.write({
      approvalId,
      toolCallId,
      type: "tool-approval-request",
    });

    const response = await waitForToolApproval({
      id: approvalId,
      provider: "anthropic",
      request: {
        input,
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
    });

    if (response.approved) {
      return {
        behavior: "allow",
        ...(response.scope === "session" && options?.suggestions
          ? { updatedPermissions: options.suggestions }
          : {}),
        toolUseID: options?.toolUseID,
        updatedInput: input,
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
const CLAUDE_ACCEPT_EDITS_PROMPT_TOOLS = new Set(["exitplanmode"]);

const normalizeClaudeToolName = (toolName) =>
  String(toolName ?? "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();

const createClaudeAcceptEditsPermissionHandler = (writer) => {
  const promptForPermission = createClaudeNativePermissionHandler(writer);

  return async (toolName, input, options) => {
    const normalizedToolName = normalizeClaudeToolName(toolName);
    const toolUseID =
      typeof options?.toolUseID === "string" ? options.toolUseID : undefined;

    if (CLAUDE_ACCEPT_EDITS_ALLOWED_TOOLS.has(normalizedToolName)) {
      return {
        behavior: "allow",
        ...(options?.suggestions
          ? { updatedPermissions: options.suggestions }
          : {}),
        ...(toolUseID ? { toolUseID } : {}),
        updatedInput: input,
      };
    }

    if (CLAUDE_ACCEPT_EDITS_PROMPT_TOOLS.has(normalizedToolName)) {
      return promptForPermission(toolName, input, options);
    }

    return {
      behavior: "deny",
      interrupt: false,
      message:
        "Accept edits only auto-approves file read and edit tools. Switch to Bypass permissions to allow this action.",
      ...(toolUseID ? { toolUseID } : {}),
    };
  };
};

export const streamClaudeResponse = async ({
  claudePermissionMode,
  messages,
  model,
  projectReferencesPrompt,
  projectPath,
  reasoningEffort,
  responseMessageMetadata,
}) => {
  const usesReasoningModel =
    getModelReasoningEfforts("anthropic", model).length > 0;
  let usesClaudeImageInput = false;
  const providerFactory = (modelId, writer) =>
    claudeCode(normalizeClaudeCodeModel(modelId), {
      ...(claudePermissionMode === "ask-permissions"
        ? {
            canUseTool: createClaudeNativePermissionHandler(writer),
            streamingInput: usesClaudeImageInput ? "always" : "auto",
          }
        : {}),
      ...(claudePermissionMode === "accept-edits"
        ? {
            canUseTool: createClaudeAcceptEditsPermissionHandler(writer),
            streamingInput: usesClaudeImageInput ? "always" : "auto",
          }
        : {}),
      ...(usesClaudeImageInput &&
      !["ask-permissions", "accept-edits"].includes(claudePermissionMode)
        ? { streamingInput: "always" }
        : {}),
      continue: false,
      cwd: projectPath,
      persistSession: false,
      // Pin the Claude Code CLI tool catalog so the model sees the full set
      // up front and has no reason to invoke the ToolSearch discovery meta-tool.
      // Keep ToolSearch explicitly denied because Claude Code may still expose
      // it as a deferred-tool loader even when the regular tool catalog is
      // pinned. This eliminates the "Read, Glob, Grep, Bash · N tools" preamble
      // chip.
      allowedTools: [
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
      ],
      disallowedTools: ["ToolSearch"],
      permissionMode: CLAUDE_PERMISSION_MODE_MAP[claudePermissionMode],
      ...(claudePermissionMode === "bypass-permissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(usesReasoningModel
        ? { effort: CLAUDE_REASONING_EFFORT_MAP[reasoningEffort ?? "medium"] }
        : {}),
    });

  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(messages);
    const normalized = normalizeClaudeImageInputs(modelMessages);
    modelMessages = normalized.messages;
    usesClaudeImageInput = normalized.hasImageInput;
  } catch (err) {
    console.error("[chat] Failed to convert messages:", err);
    const detail =
      err instanceof Error && err.message ? err.message : String(err);
    return new Response(`Failed to prepare messages: ${detail}`, {
      status: 400,
    });
  }

  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (error) => {
      console.error("[chat stream error]", error);
      return formatStreamError(error);
    },
    execute: ({ writer }) => {
      const textResult = streamText({
        messages: modelMessages,
        model: providerFactory(model, writer),
        stopWhen: stepCountIs(
          usesReasoningModel
            ? REASONING_TOOL_STEP_LIMIT
            : DEFAULT_TOOL_STEP_LIMIT,
        ),
        system: [SYSTEM_PROMPT, projectReferencesPrompt]
          .filter(Boolean)
          .join("\n\n"),
        ...(usesReasoningModel ? {} : { temperature: 0.2 }),
        tools: createClaudeProjectTools({ claudePermissionMode, projectPath }),
      });

      writer.merge(
        textResult.toUIMessageStream({
          messageMetadata: ({ part }) => {
            if (part.type === "finish") {
              return {
                ...responseMessageMetadata,
                usage: part.totalUsage,
              };
            }

            if (part.type === "start") {
              return responseMessageMetadata;
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
  return createUIMessageStreamResponse({ stream });
};
