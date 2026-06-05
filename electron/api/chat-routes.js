import { promises as fs } from "node:fs";
import { resolvePersistedProjectPath } from "../persisted-state.js";
import { streamClaudeResponse } from "./chat/claude-stream.js";
import { streamCodexAppServerResponse } from "./chat/codex-app-server.js";
import { streamCodexCliResponse } from "./chat/codex-cli-stream.js";
import { streamCursorResponse } from "./chat/cursor-stream.js";
import { streamOpenCodeResponse } from "./chat/opencode-stream.js";
import {
  chatRequestBodySchema,
  chatTitleRequestBodySchema,
  formatProjectReferencesForPrompt,
  SYSTEM_PROMPT,
} from "./chat/schema.js";
import { generateChatTitle } from "./chat/title.js";
import { readCodexAccessToken } from "./providers/codex-auth.js";
import {
  getCursorCliUnavailableMessage,
  isCursorCliAvailable,
} from "./providers/cursor-cli.js";
import { isCliCommandAvailable } from "./shared/cli.js";

const validateProjectPath = async (projectPath) => {
  try {
    const projectStats = await fs.stat(projectPath);
    return projectStats.isDirectory()
      ? null
      : { message: "projectPath must point to a directory.", status: 400 };
  } catch {
    return { message: "Project path does not exist.", status: 400 };
  }
};

const validateCodexReady = async () => {
  const codexInstalled = await isCliCommandAvailable("codex");
  if (!codexInstalled) {
    return {
      message: "Codex CLI is not installed or not available on PATH.",
      status: 400,
    };
  }

  const accessToken = await readCodexAccessToken();
  if (!accessToken) {
    return {
      message: "Codex login not found. Run `codex login` and try again.",
      status: 401,
    };
  }

  return null;
};

const validateClaudeReady = async () => {
  const claudeInstalled = await isCliCommandAvailable("claude");
  if (!claudeInstalled) {
    return {
      message: "Claude Code CLI is not installed or not available on PATH.",
      status: 400,
    };
  }

  return null;
};

const validateOpenCodeReady = async () => {
  const openCodeInstalled = await isCliCommandAvailable("opencode");
  if (!openCodeInstalled) {
    return {
      message: "OpenCode CLI is not installed or not available on PATH.",
      status: 400,
    };
  }

  return null;
};

const validateCursorReady = async () => {
  const cursorInstalled = await isCursorCliAvailable();
  if (!cursorInstalled) {
    return {
      message: getCursorCliUnavailableMessage(),
      status: 400,
    };
  }

  return null;
};

export const registerChatRoutes = (app) => {
  app.post("/api/chat-title", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = chatTitleRequestBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const { fallbackModel, projectPath, promptText, provider } = parsed.data;
    const projectPathError = await validateProjectPath(projectPath);
    if (projectPathError) {
      return c.text(projectPathError.message, projectPathError.status);
    }

    if (provider === "openai") {
      const codexError = await validateCodexReady();
      if (codexError) {
        return c.text(codexError.message, codexError.status);
      }
    } else if (provider === "opencode") {
      const openCodeError = await validateOpenCodeReady();
      if (openCodeError) {
        return c.text(openCodeError.message, openCodeError.status);
      }
    } else if (provider === "cursor") {
      const cursorError = await validateCursorReady();
      if (cursorError) {
        return c.text(cursorError.message, cursorError.status);
      }
    } else {
      const claudeError = await validateClaudeReady();
      if (claudeError) {
        return c.text(claudeError.message, claudeError.status);
      }
    }

    try {
      const title = await generateChatTitle({
        fallbackModel,
        projectPath,
        promptText,
        provider,
      });
      return c.json({ title });
    } catch (error) {
      const detail =
        error instanceof Error && error.message
          ? error.message
          : "Chat title generation failed.";
      return c.text(detail, 500);
    }
  });

  app.post("/api/chat", async (c) => {
    let rawBody;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.text("Invalid JSON payload.", 400);
    }

    const parsed = chatRequestBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.text(parsed.error.message, 400);
    }

    const {
      chatId,
      agentMode,
      claudePermissionMode,
      codexPermissionMode,
      messages,
      model,
      modelLabel,
      modelSpeed,
      modelSpeedLabel,
      projectReferences,
      projectPath,
      projectId,
      provider,
      reasoningEffort,
      reasoningLabel,
      remoteConversationId,
      remoteConversationModel,
      remoteConversationModelSpeed,
      remoteConversationProjectPath,
      threadId,
    } = parsed.data;
    const resolvedChatId = chatId ?? threadId;
    const resolvedProjectPath =
      resolvePersistedProjectPath({
        chatId: resolvedChatId,
        projectId,
      }) ?? projectPath;
    const responseMessageMetadata = {
      createdAt: new Date().toISOString(),
      model,
      modelLabel: modelLabel ?? model,
      modelSpeed,
      ...(modelSpeedLabel ? { modelSpeedLabel } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(reasoningLabel ? { reasoningLabel } : {}),
    };
    const projectReferencesPrompt =
      formatProjectReferencesForPrompt(projectReferences);

    const projectPathError = await validateProjectPath(resolvedProjectPath);
    if (projectPathError) {
      return c.text(projectPathError.message, projectPathError.status);
    }

    if (provider === "openai") {
      const codexError = await validateCodexReady();
      if (codexError) {
        return c.text(codexError.message, codexError.status);
      }

      if (codexPermissionMode === "default") {
        return streamCodexAppServerResponse({
          abortSignal: c.req.raw.signal,
          chatId: resolvedChatId,
          codexPermissionMode,
          messages,
          model,
          projectReferencesPrompt,
          projectPath: resolvedProjectPath,
          modelSpeed,
          reasoningEffort,
          responseMessageMetadata,
          systemPrompt: SYSTEM_PROMPT,
        });
      }

      return streamCodexCliResponse({
        abortSignal: c.req.raw.signal,
        chatId: resolvedChatId,
        codexPermissionMode,
        messages,
        model,
        projectReferencesPrompt,
        projectPath: resolvedProjectPath,
        modelSpeed,
        reasoningEffort,
        remoteConversationId,
        remoteConversationModel,
        remoteConversationModelSpeed,
        remoteConversationProjectPath,
        responseMessageMetadata,
        systemPrompt: SYSTEM_PROMPT,
      });
    }

    if (provider === "opencode") {
      const openCodeError = await validateOpenCodeReady();
      if (openCodeError) {
        return c.text(openCodeError.message, openCodeError.status);
      }

      return streamOpenCodeResponse({
        abortSignal: c.req.raw.signal,
        agentMode,
        codexPermissionMode,
        messages,
        model,
        projectReferencesPrompt,
        projectPath: resolvedProjectPath,
        responseMessageMetadata,
        systemPrompt: SYSTEM_PROMPT,
      });
    }

    if (provider === "cursor") {
      const cursorError = await validateCursorReady();
      if (cursorError) {
        return c.text(cursorError.message, cursorError.status);
      }

      return streamCursorResponse({
        abortSignal: c.req.raw.signal,
        codexPermissionMode,
        messages,
        model,
        modelSpeed,
        projectReferencesPrompt,
        projectPath: resolvedProjectPath,
        remoteConversationId,
        remoteConversationModel,
        remoteConversationModelSpeed,
        remoteConversationProjectPath,
        responseMessageMetadata,
        systemPrompt: SYSTEM_PROMPT,
      });
    }

    const claudeError = await validateClaudeReady();
    if (claudeError) {
      return c.text(claudeError.message, claudeError.status);
    }

    return streamClaudeResponse({
      agentMode,
      claudePermissionMode,
      messages,
      model,
      projectReferencesPrompt,
      projectPath: resolvedProjectPath,
      reasoningEffort,
      responseMessageMetadata,
    });
  });
};
