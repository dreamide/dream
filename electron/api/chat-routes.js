import { promises as fs } from "node:fs";
import { z } from "zod";
import { resolvePersistedProjectPath } from "../persisted-state.js";
import { turnObservers } from "./chat/agent-turn.js";
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
  createTurnRegistry,
  TurnInProgressError,
} from "./chat/turn-registry.js";
import {
  attachCheckpointFinalizer,
  createCheckpoint,
  finalizeCheckpoint,
} from "./checkpoints/service.js";
import { getProvider } from "./providers/registry.js";
import { handleJsonRoute, RouteError } from "./shared/json-route.js";

const CHECKPOINT_CAPTURE_TIMEOUT_MS = 20_000;

/** The origin the host stamps on catalog changes it makes itself. */
export const HOST_ORIGIN = "host";

export const chatStopRequestSchema = z.object({ chatId: z.string().min(1) });

/**
 * What the host keeps of a turn while it runs: the transcript after every
 * step and at the end, and (at the end) the provider session the turn
 * reported, so a turn nobody watched can still be resumed later. The
 * transcript is the client's own request (not what a provider made of it)
 * with the assistant message being written in place of, or after, its last
 * message.
 */
const createTurnRecorder = ({
  catalog,
  chatId,
  projectPath,
  requestMessages,
}) => ({
  async onMessage(message, { final }) {
    const continued = requestMessages.at(-1)?.role === "assistant";
    const messages = [
      ...(continued ? requestMessages.slice(0, -1) : requestMessages),
      message,
    ];
    await catalog.saveTranscript(chatId, messages, { origin: HOST_ORIGIN });
    if (!final) return;

    const metadata = message?.metadata;
    const sessionId =
      typeof metadata?.remoteConversationId === "string"
        ? metadata.remoteConversationId.trim()
        : "";
    const chat = sessionId ? catalog.getChat(chatId) : null;
    if (!chat || chat.remoteConversationId === sessionId) return;
    await catalog.applyChanges(
      {
        chats: [
          {
            ...chat,
            remoteConversationId: sessionId,
            remoteConversationModel:
              metadata.remoteConversationModel ?? chat.model,
            remoteConversationModelSpeed:
              metadata.remoteConversationModelSpeed ?? chat.modelSpeed,
            remoteConversationProjectPath:
              metadata.remoteConversationProjectPath ?? projectPath,
          },
        ],
      },
      { origin: HOST_ORIGIN },
    );
  },
});

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

/**
 * @param {import("hono").Hono} app
 * @param {{
 *   catalog?: ReturnType<typeof import("../host/catalog.js").createHostCatalog>,
 *   turns?: ReturnType<typeof createTurnRegistry>,
 * }} [options]
 *   `catalog`: where a turn's transcript is saved as it runs (none in route
 *   tests). `turns`: the host's running turns.
 */
export const registerChatRoutes = (
  app,
  { catalog = null, turns = createTurnRegistry() } = {},
) => {
  // A running turn's stream from its start, for a client that reconnects
  // (the AI SDK's resumable stream); 204 when none runs.
  app.get("/api/chat/:chatId/stream", (c) => {
    const resumed = turns.resume(c.req.param("chatId"));
    return resumed ?? c.body(null, 204);
  });

  // The only way a turn ends early: a dropped request does not stop it.
  app.post("/api/chat/stop", (c) =>
    handleJsonRoute(c, chatStopRequestSchema, ({ chatId }) => ({
      stopped: turns.stop(chatId),
    })),
  );

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
    if (resolvedChatId && turns.isRunning(resolvedChatId)) {
      return c.text(new TurnInProgressError(resolvedChatId).message, 409);
    }
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

    const runTurn = async (abortSignal) => {
      const recorder =
        catalog && resolvedChatId
          ? createTurnRecorder({
              catalog,
              chatId: resolvedChatId,
              projectPath: resolvedProjectPath,
              requestMessages: messages,
            })
          : null;
      const streamTurn = () =>
        provider.stream({
          abortSignal,
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
      const streamResponse = recorder
        ? await turnObservers.run(recorder, streamTurn)
        : await streamTurn();
      if (!checkpointId || !(streamResponse instanceof Response)) {
        return streamResponse;
      }

      return attachCheckpointFinalizer(streamResponse, abortSignal, () =>
        finalizeCheckpoint({
          chatId: resolvedChatId,
          checkpointId,
          projectPath: resolvedProjectPath,
        }),
      );
    };

    // Without a chat id there is nothing to resume or stop by: the turn is
    // simply the request's.
    if (!resolvedChatId) {
      return runTurn(c.req.raw.signal);
    }
    try {
      return await turns.start({ chatId: resolvedChatId, run: runTurn });
    } catch (error) {
      if (error instanceof TurnInProgressError) {
        return c.text(error.message, 409);
      }
      throw error;
    }
  });
};
