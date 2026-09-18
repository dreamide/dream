import { randomUUID } from "node:crypto";
import {
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
} from "ai";
import { streamClaudeResponse } from "../chat/claude-stream.js";
import { streamCodexAppServerResponse } from "../chat/codex-app-server.js";
import { streamCursorResponse } from "../chat/cursor-stream.js";
import { streamGrokResponse } from "../chat/grok-stream.js";
import { streamOpenCodeResponse } from "../chat/opencode-stream.js";
import { resolveChatPermissionModes } from "../chat/permissions.js";

/**
 * GraphAgentExecutor backed by Dream's existing provider stream adapters.
 *
 * Each node execution is one agent turn: we build a single user message from
 * the engine's prompt, dispatch to the provider exactly like `/api/chat`
 * does, consume the resulting UI message stream in-process, and hand the
 * raw text back to the engine (which extracts the structured result).
 */

const PROVIDERS = new Set([
  "anthropic",
  "openai",
  "opencode",
  "cursor",
  "grok",
]);

const createAbortError = () =>
  Object.assign(new Error("Run cancelled."), { name: "AbortError" });

/**
 * Resolves the agent configuration for a node: node-level settings override
 * the run's default agent (captured from the project when the run started).
 */
export const resolveNodeAgent = (nodeAgent, defaultAgent) => {
  const merged = { ...(defaultAgent ?? {}), ...(nodeAgent ?? {}) };
  for (const key of Object.keys(merged)) {
    if (
      merged[key] === null ||
      merged[key] === undefined ||
      merged[key] === ""
    ) {
      delete merged[key];
    }
  }
  // Node-level provider switches invalidate an inherited model.
  if (
    nodeAgent?.provider &&
    nodeAgent.provider !== defaultAgent?.provider &&
    !nodeAgent.model
  ) {
    delete merged.model;
  }
  return {
    agentMode: merged.agentMode === "plan" ? "plan" : "build",
    model: typeof merged.model === "string" ? merged.model : "",
    modelSpeed: merged.modelSpeed === "fast" ? "fast" : "standard",
    provider: PROVIDERS.has(merged.provider) ? merged.provider : null,
    reasoningEffort:
      typeof merged.reasoningEffort === "string"
        ? merged.reasoningEffort
        : null,
  };
};

const collectText = (message) =>
  (message?.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();

/**
 * Reads a UI message stream `Response` to completion and returns the final
 * assistant text. Throws on stream errors or cancellation.
 */
export const readAgentResponseText = async (response, { signal } = {}) => {
  if (!(response instanceof Response)) {
    throw new Error("Provider did not return a response.");
  }
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `Provider request failed (${response.status}).`);
  }

  const chunkStream = parseJsonEventStream({
    schema: uiMessageChunkSchema,
    stream: response.body,
  }).pipeThrough(
    new TransformStream({
      transform(parsed, controller) {
        if (parsed.success) {
          controller.enqueue(parsed.value);
        }
      },
    }),
  );

  let streamError = null;
  const reader = readUIMessageStream({
    onError: (error) => {
      streamError = error instanceof Error ? error : new Error(String(error));
    },
    stream: chunkStream,
    terminateOnError: true,
  });

  const onAbort = () => {
    void response.body?.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  let lastMessage = null;
  try {
    for await (const message of reader) {
      lastMessage = message;
      if (signal?.aborted) {
        throw createAbortError();
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw createAbortError();
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  if (signal?.aborted) {
    throw createAbortError();
  }
  if (streamError) {
    throw streamError;
  }

  return collectText(lastMessage);
};

export const createProviderGraphExecutor = ({
  mcpServers = [],
  dispatch = null,
} = {}) => {
  const dispatchStream = async ({ agent, messages, projectPath, signal }) => {
    if (dispatch) {
      return dispatch({ agent, messages, projectPath, signal });
    }

    const { claudePermissionMode, codexPermissionMode } =
      resolveChatPermissionModes({
        agentMode: agent.agentMode,
        permissionMode: "full-access",
      });
    const responseMessageMetadata = {
      createdAt: new Date().toISOString(),
      model: agent.model,
      modelLabel: agent.model,
      modelSpeed: agent.modelSpeed,
    };
    const common = {
      messages,
      model: agent.model,
      modelSpeed: agent.modelSpeed,
      projectPath,
      projectReferencesPrompt: null,
      remoteConversationId: null,
      remoteConversationModel: null,
      remoteConversationModelSpeed: null,
      remoteConversationProjectPath: null,
      responseMessageMetadata,
    };

    switch (agent.provider) {
      case "openai":
        return streamCodexAppServerResponse({
          ...common,
          abortSignal: signal,
          codexPermissionMode,
          mcpServers,
          reasoningEffort: agent.reasoningEffort,
        });
      case "opencode":
        return streamOpenCodeResponse({
          ...common,
          abortSignal: signal,
          agentMode: agent.agentMode,
          codexPermissionMode,
          mcpServers,
        });
      case "cursor":
        return streamCursorResponse({
          ...common,
          abortSignal: signal,
          codexPermissionMode,
        });
      case "grok":
        return streamGrokResponse({
          ...common,
          abortSignal: signal,
          agentMode: agent.agentMode,
          codexPermissionMode,
          mcpServers,
          reasoningEffort: agent.reasoningEffort,
        });
      default:
        return streamClaudeResponse({
          ...common,
          agentMode: agent.agentMode,
          claudePermissionMode,
          mcpServers,
          reasoningEffort: agent.reasoningEffort,
        });
    }
  };

  return {
    execute: async ({ graph, node, projectPath, prompt, signal }) => {
      if (!projectPath) {
        throw new Error("Project path could not be resolved for this run.");
      }
      const agent = resolveNodeAgent(node.agent, graph.defaultAgent);
      if (!agent.provider || !agent.model) {
        throw new Error(
          `Node "${node.name}" has no provider/model configured and the project has no default.`,
        );
      }
      if (signal?.aborted) {
        throw createAbortError();
      }

      const messages = [
        {
          id: randomUUID(),
          parts: [{ text: prompt, type: "text" }],
          role: "user",
        },
      ];
      const response = await dispatchStream({
        agent,
        messages,
        projectPath,
        signal,
      });
      const text = await readAgentResponseText(response, { signal });
      return { agent, text };
    },
  };
};
