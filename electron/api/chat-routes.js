import { promises as fs } from "node:fs";
import { z } from "zod";
import { appendBrowserMcpServer } from "./chat/browser-tools.js";
import { startProviderSession } from "./chat/provider-session.js";
import {
  chatQueueControlSchema,
  chatQueueRequestSchema,
  chatRequestBodySchema,
  chatSubmitRequestSchema,
  chatTitleRequestBodySchema,
  formatProjectReferencesForPrompt,
} from "./chat/schema.js";
import {
  applySkillDispatchToMessages,
  resolveSkillDispatch,
} from "./chat/skill-dispatch.js";
import { generateChatTitle } from "./chat/title.js";
import { executeAgentTurn } from "./chat/turn-execution.js";
import {
  createTurnRegistry,
  TurnInProgressError,
} from "./chat/turn-registry.js";
import { prepareTurnTranscript } from "./chat/turn-transcript.js";
import {
  captureTurnCheckpoint,
  finalizeCheckpoint,
} from "./checkpoints/service.js";
import { getProvider } from "./providers/registry.js";
import { handleJsonRoute, RouteError } from "./shared/json-route.js";

export const chatStopRequestSchema = z.object({ chatId: z.string().min(1) });

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
  signal,
}) => {
  if (!checkpointsEnabled || !chatId) {
    return null;
  }

  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "user") {
    return getContinuationCheckpointId(lastMessage);
  }

  // How long, and until what, the turn waits is the service's.
  return captureTurnCheckpoint({ chatId, projectPath, signal });
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
 *   scheduler?: ReturnType<typeof import("./chat/run-scheduler.js").createRunScheduler>,
 * }} [options]
 *   `catalog`: where a turn's transcript is saved as it runs (none in route
 *   tests). `turns`: the host's running turns.
 */
export const registerChatRoutes = (
  app,
  { catalog = null, turns = createTurnRegistry(), scheduler = null } = {},
) => {
  if (scheduler) {
    app.post("/api/chat/submit", (c) =>
      handleJsonRoute(c, chatSubmitRequestSchema, (data) =>
        scheduler.submit(data),
      ),
    );
    app.post("/api/chat/queue", (c) =>
      handleJsonRoute(c, chatQueueRequestSchema, ({ chatId }) =>
        scheduler.list(chatId),
      ),
    );
    app.post("/api/chat/queue/control", (c) =>
      handleJsonRoute(c, chatQueueControlSchema, (data) =>
        scheduler.control(data),
      ),
    );
  }
  // A running turn's stream, for a client that reconnects (the AI SDK's
  // resumable stream): from its start, or from `from` for a client that
  // holds the bytes before it (`turn` names which turn); 204 when none runs.
  app.get("/api/chat/:chatId/stream", (c) => {
    const from = Number(c.req.query("from"));
    const resumed = turns.resume(c.req.param("chatId"), {
      from: Number.isSafeInteger(from) ? from : null,
      turnId: c.req.query("turn") ?? null,
    });
    return resumed ?? c.body(null, 204);
  });

  // The only way a turn ends early: a dropped request does not stop it.
  app.post("/api/chat/stop", (c) =>
    handleJsonRoute(c, chatStopRequestSchema, async ({ chatId }) => {
      if (scheduler) {
        await scheduler.control({ chatId, action: "stop" });
        return { stopped: true };
      }
      return { stopped: turns.stop(chatId) };
    }),
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

    const resolvedChatId = parsed.data.chatId ?? parsed.data.threadId;
    const run = (signal) =>
      executeChatRequest(parsed.data, { catalog, signal });
    if (!resolvedChatId) return run(c.req.raw.signal);
    try {
      return await turns.start({ chatId: resolvedChatId, run });
    } catch (error) {
      if (error instanceof TurnInProgressError)
        return c.text(error.message, 409);
      throw error;
    }
  });
};

/**
 * Runs one chat request. `requestSaved`: the request's messages are already
 * in the catalog as they are (a Chat run saved its submission), so the turn
 * saves only the message it writes.
 */
export async function executeChatRequest(
  data,
  { catalog, signal, onChunk, orchestration, requestSaved = false },
) {
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
    threadId,
    mcpServers: configuredMcpServers,
  } = data;
  const mcpServers = [
    ...(configuredMcpServers ?? []),
    ...(orchestration?.mcpServers ?? []),
  ];
  const provider = getProvider(providerId);
  const resolvedChatId = chatId ?? threadId;
  const resolvedProjectPath =
    (catalog
      ? await catalog.resolveProjectPath({
          chatId: resolvedChatId,
          projectId,
        })
      : null) ?? projectPath;

  const projectPathError = await validateProjectPath(resolvedProjectPath);
  if (projectPathError) {
    return new Response(projectPathError.message, {
      status: projectPathError.status,
    });
  }

  const readyError = await provider.checkReady();
  if (readyError) {
    return new Response(readyError.message, { status: readyError.status });
  }

  const startedAt = new Date().toISOString();
  const responseMessageMetadata = {
    createdAt: startedAt,
    startedAt,
    model,
    modelLabel: modelLabel ?? model,
    modelSpeed,
    ...(modelSpeedLabel ? { modelSpeedLabel } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(reasoningLabel ? { reasoningLabel } : {}),
  };
  // Read once for the session check and the turn's saves and fingerprint.
  const transcript = prepareTurnTranscript(messages, { saved: requestSaved });
  // What the turn starts from on the provider's side. The request's own
  // `remoteConversation*` fields are ignored: the host keeps the session.
  const providerSession = await startProviderSession({
    catalog,
    chatId: resolvedChatId,
    provider,
    messages,
    transcript,
    projectPath: resolvedProjectPath,
    model,
    modelSpeed,
    permissionMode,
    mcpServers,
    orchestrationTools: Boolean(orchestration?.tools),
    signal,
  });
  const checkpointId = await resolveTurnCheckpointId({
    chatId: resolvedChatId,
    checkpointsEnabled,
    messages,
    projectPath: resolvedProjectPath,
    signal,
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
    const streamTurn = () =>
      provider.stream({
        orchestrationTools: orchestration?.tools,
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
          formatProjectReferencesForPrompt(projectReferences) || null,
        reasoningEffort,
        resumeSessionId: providerSession.resumeSessionId,
        sessionHandoff: providerSession.handoff,
        responseMessageMetadata,
        skillSlashCommand: skillDispatch?.slashCommand,
      });
    return executeAgentTurn(
      {
        catalog,
        chatId: resolvedChatId,
        requestMessages: messages,
        transcript,
        providerSession,
        onChunk,
        finalize: checkpointId
          ? () =>
              finalizeCheckpoint({
                chatId: resolvedChatId,
                checkpointId,
                projectPath: resolvedProjectPath,
              })
          : undefined,
      },
      streamTurn,
    );
  };

  return runTurn(signal);
}
