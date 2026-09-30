import { promises as fs } from "node:fs";
import { resolvePersistedProjectPath } from "../persisted-state.js";
import { appendBrowserMcpServer } from "./chat/browser-tools.js";
import {
  chatRequestBodySchema,
  chatTitleRequestBodySchema,
  formatProjectReferencesForPrompt,
} from "./chat/schema.js";
import {
  applySkillDispatchToMessages,
  resolveSkillDispatch,
} from "./chat/skill-dispatch.js";
import { generateChatTitle } from "./chat/title.js";
import {
  attachCheckpointFinalizer,
  createCheckpoint,
  finalizeCheckpoint,
} from "./checkpoints/service.js";
import { getProvider } from "./providers/registry.js";
import { handleJsonRoute, RouteError } from "./shared/json-route.js";

const CHECKPOINT_CAPTURE_TIMEOUT_MS = 20_000;

const withTimeout = (promise, timeoutMs) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Checkpoint capture timed out.")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const getContinuationCheckpointId = (lastMessage) => {
  const metadata = lastMessage?.metadata;
  const checkpointId =
    metadata && typeof metadata === "object" ? metadata.checkpointId : null;
  return typeof checkpointId === "string" && checkpointId ? checkpointId : null;
};

const resolveTurnCheckpointId = async ({
  chatId,
  checkpointsEnabled,
  messages,
  projectPath,
}) => {
  if (!checkpointsEnabled || !chatId) {
    return null;
  }

  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "user") {
    return getContinuationCheckpointId(lastMessage);
  }

  try {
    const checkpoint = await withTimeout(
      createCheckpoint({ chatId, projectPath }),
      CHECKPOINT_CAPTURE_TIMEOUT_MS,
    );
    return checkpoint.checkpointId;
  } catch (error) {
    console.warn("[checkpoints] Skipping checkpoint for this turn:", error);
    return null;
  }
};

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

export const registerChatRoutes = (app) => {
  app.post("/api/chat-title", (c) =>
    handleJsonRoute(
      c,
      chatTitleRequestBodySchema,
      async ({ fallbackModel, projectPath, promptText, provider }) => {
        const projectPathError = await validateProjectPath(projectPath);
        if (projectPathError) {
          throw new RouteError(
            projectPathError.message,
            projectPathError.status,
          );
        }

        const readyError = await getProvider(provider).checkReady();
        if (readyError) {
          throw new RouteError(readyError.message, readyError.status);
        }

        return {
          title: await generateChatTitle({
            fallbackModel,
            projectPath,
            promptText,
            provider,
          }),
        };
      },
      { errorMessage: "Chat title generation failed.", errorStatus: 500 },
    ),
  );

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
      checkpointsEnabled,
      messages,
      model,
      modelLabel,
      modelSpeed,
      modelSpeedLabel,
      projectReferences,
      projectPath,
      projectId,
      permissionMode,
      provider: providerId,
      reasoningEffort,
      reasoningLabel,
      remoteConversationId,
      remoteConversationModel,
      remoteConversationModelSpeed,
      remoteConversationProjectPath,
      threadId,
      mcpServers,
    } = parsed.data;
    const provider = getProvider(providerId);
    const resolvedChatId = chatId ?? threadId;
    const resolvedProjectPath =
      resolvePersistedProjectPath({
        chatId: resolvedChatId,
        projectId,
      }) ?? projectPath;

    const projectPathError = await validateProjectPath(resolvedProjectPath);
    if (projectPathError) {
      return c.text(projectPathError.message, projectPathError.status);
    }

    const readyError = await provider.checkReady();
    if (readyError) {
      return c.text(readyError.message, readyError.status);
    }

    const responseMessageMetadata = {
      createdAt: new Date().toISOString(),
      model,
      modelLabel: modelLabel ?? model,
      modelSpeed,
      ...(modelSpeedLabel ? { modelSpeedLabel } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(reasoningLabel ? { reasoningLabel } : {}),
    };
    const checkpointId = await resolveTurnCheckpointId({
      chatId: resolvedChatId,
      checkpointsEnabled,
      messages,
      projectPath: resolvedProjectPath,
    });
    if (checkpointId) {
      responseMessageMetadata.checkpointId = checkpointId;
    }

    // `$skill` mentions in the latest user message become whatever the
    // provider expands natively (see skill-dispatch.js): nothing, an
    // instruction part, or a slash prefix on the prompt.
    const skillDispatch = await resolveSkillDispatch({
      mcpServers,
      messages,
      projectPath: resolvedProjectPath,
      provider: providerId,
    });

    const streamResponse = await provider.stream({
      abortSignal: c.req.raw.signal,
      chatId: resolvedChatId,
      // Dream's browser tools reach the agent over MCP where the provider
      // takes MCP config per session; Claude gets them in-process instead.
      mcpServers: provider.browserMcpScope
        ? appendBrowserMcpServer(mcpServers, {
            projectId,
            scope: provider.browserMcpScope,
          })
        : mcpServers,
      messages: applySkillDispatchToMessages(messages, skillDispatch),
      model,
      modelSpeed,
      permissionMode,
      projectId,
      projectPath: resolvedProjectPath,
      projectReferencesPrompt:
        formatProjectReferencesForPrompt(projectReferences),
      reasoningEffort,
      remoteConversationId,
      remoteConversationModel,
      remoteConversationModelSpeed,
      remoteConversationProjectPath,
      responseMessageMetadata,
      skillSlashCommand: skillDispatch?.slashCommand,
    });
    if (!checkpointId || !(streamResponse instanceof Response)) {
      return streamResponse;
    }

    return attachCheckpointFinalizer(streamResponse, c.req.raw.signal, () =>
      finalizeCheckpoint({
        chatId: resolvedChatId,
        checkpointId,
        projectPath: resolvedProjectPath,
      }),
    );
  });
};
