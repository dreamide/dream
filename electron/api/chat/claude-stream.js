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
  "plan-mode": "plan",
  "bypass-permissions": "bypassPermissions",
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

const normalizeClaudeToolName = (toolName) =>
  String(toolName ?? "")
    .replace(/[\s_-]+/g, "")
    .toLowerCase();

const createClaudeAcceptEditsPermissionHandler = () => {
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
  const providerFactory = (modelId, writer) =>
    claudeCode(normalizeClaudeCodeModel(modelId), {
      ...(claudePermissionMode === "ask-permissions"
        ? {
            canUseTool: createClaudeNativePermissionHandler(writer),
            streamingInput: "auto",
          }
        : {}),
      ...(claudePermissionMode === "accept-edits"
        ? {
            canUseTool: createClaudeAcceptEditsPermissionHandler(),
            streamingInput: "auto",
          }
        : {}),
      continue: false,
      cwd: projectPath,
      persistSession: false,
      permissionMode: CLAUDE_PERMISSION_MODE_MAP[claudePermissionMode],
      ...(claudePermissionMode === "bypass-permissions"
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(usesReasoningModel
        ? { effort: CLAUDE_REASONING_EFFORT_MAP[reasoningEffort] }
        : {}),
    });

  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(messages);
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
          messageMetadata: ({ part }) =>
            part.type === "start" || part.type === "finish"
              ? responseMessageMetadata
              : undefined,
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
