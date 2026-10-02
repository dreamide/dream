// The agent-turn writer.
//
// One implementation of what the chat client receives for a turn, whichever
// agent CLI produced it. A provider adapter translates its native events into
// calls on the small interface below; the writer owns the chunk shapes, the
// approval-id scheme, text buffering and part bookkeeping, session and usage
// metadata, the output cap, and error formatting. Adding a provider means
// writing a translator, not another copy of the contract.
//
//   turn.text(delta, id?) / turn.reasoning(delta, id?)   streamed prose
//   turn.endText(id, type?) / turn.closeText()           part boundaries
//   turn.toolStart / turn.toolOutput / turn.toolError    provider-run tools
//                                   (each stamped with its kind, see below)
//   turn.approval(...)                                   ask the user
//   turn.todos(payload) / turn.todosFromTool(item)       plan updates
//   turn.compaction(id, state)                           context compaction
//   turn.session(id) / turn.usage(usage, contextWindow)  message metadata
//   turn.merge(stream)                                   an AI SDK stream
//
// Everything is idempotent where a provider is likely to repeat itself: a
// tool started twice is written once, a completed tool stays completed.
//
// Every tool part says what it is: the writer stamps `toolMetadata.kind`
// (see electron/shared/tool-call.js) on each tool it writes, from the kind
// the adapter passes when it knows one natively, or else from the tool's
// name. Tools in a merged AI SDK stream (Claude's) are stamped the same way,
// so the transcript classifies a tool once, here, whatever produced it.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  readUIMessageStream,
} from "ai";
import { formatApprovalId } from "../../shared/agent-turn-contract.js";
import { getToolKindForName, isToolKind } from "../../shared/tool-call.js";
import { waitForToolApproval } from "../tool-approvals.js";
import { formatStreamError } from "./errors.js";

export const DEFAULT_MAX_TEXT_CHARS = 250_000;
const TEXT_FLUSH_INTERVAL_MS = 50;

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const toFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Usage in the shape the client reads. Adapters report the four numbers
 * they know; an AI SDK usage object (Claude) passes through untouched.
 */
export const formatTurnUsage = (usage) => {
  if (!isRecord(usage)) {
    return null;
  }
  if (
    isRecord(usage.inputTokens) ||
    isRecord(usage.inputTokenDetails) ||
    isRecord(usage.outputTokenDetails)
  ) {
    return usage;
  }

  const inputTokens = toFiniteNumber(usage.inputTokens) ?? 0;
  const outputTokens = toFiniteNumber(usage.outputTokens) ?? 0;
  const reasoningTokens = toFiniteNumber(usage.reasoningTokens) ?? 0;
  const cacheReadTokens = toFiniteNumber(usage.cacheReadTokens) ?? 0;

  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens ? { cachedInputTokens: cacheReadTokens } : {}),
    ...(cacheReadTokens ? { inputTokenDetails: { cacheReadTokens } } : {}),
    ...(reasoningTokens ? { reasoningTokens } : {}),
    ...(reasoningTokens ? { outputTokenDetails: { reasoningTokens } } : {}),
  };
};

// ── Plan (todo list) payloads ─────────────────────────────────────────

const TODO_ARRAY_KEYS = [
  "plan",
  "todos",
  "tasks",
  "items",
  "steps",
  "entries",
  "data",
  "input",
  "arguments",
  "args",
  "result",
];

const getArrayFromPayload = (payload, depth = 0) => {
  if (depth > 4) {
    return null;
  }

  if (typeof payload === "string") {
    try {
      return getArrayFromPayload(JSON.parse(payload), depth + 1);
    } catch {
      return null;
    }
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  if (!isRecord(payload)) {
    return null;
  }

  for (const key of TODO_ARRAY_KEYS) {
    const todos = getArrayFromPayload(payload[key], depth + 1);
    if (todos) {
      return todos;
    }
  }

  return null;
};

export const isTodoToolName = (toolName) =>
  getToolKindForName(toolName) === "todo";

/**
 * The metadata a tool part is stamped with: its kind (see tool-call.js),
 * or none for a tool Dream renders generically.
 */
const getToolMetadata = (toolName, kind) => {
  const resolved = isToolKind(kind) ? kind : getToolKindForName(toolName);
  return resolved ? { kind: resolved } : undefined;
};

const STAMPED_TOOL_CHUNK_TYPES = new Set([
  "tool-input-start",
  "tool-input-available",
  "tool-input-error",
]);

/** Stamps the tool chunks of a merged stream with their kind. */
const stampToolKinds = () =>
  new TransformStream({
    transform(chunk, controller) {
      if (
        STAMPED_TOOL_CHUNK_TYPES.has(chunk?.type) &&
        !isToolKind(chunk.toolMetadata?.kind)
      ) {
        const toolMetadata = getToolMetadata(chunk.toolName);
        if (toolMetadata) {
          controller.enqueue({
            ...chunk,
            toolMetadata: { ...chunk.toolMetadata, ...toolMetadata },
          });
          return;
        }
      }
      controller.enqueue(chunk);
    },
  });

// ── The turn ──────────────────────────────────────────────────────────

/**
 * Builds a turn over an AI SDK UI-message stream writer. `streamAgentTurn`
 * is the normal entry point; this is exported for adapters that hand the
 * turn to SDK callbacks, and for tests.
 */
export const createAgentTurn = ({
  writer,
  provider,
  label = provider,
  model,
  modelSpeed = "standard",
  projectPath,
  responseMessageMetadata = {},
  abortSignal,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
}) => {
  let sessionId = null;
  let streamedChars = 0;
  let textLimited = false;
  const activeParts = new Map();
  const closedParts = new Set();
  const autoPartIds = { reasoning: null, text: null };
  const pending = { id: null, text: "", timer: null, type: null };
  const startedTools = new Set();
  const completedTools = new Set();

  const write = (chunk) => {
    writer.write(chunk);
  };

  const partKey = (type, id) => `${type}:${id}`;

  const openPart = (type, id) => {
    const key = partKey(type, id);
    if (closedParts.has(key)) {
      return false;
    }
    if (!activeParts.has(key)) {
      write({ id, type: `${type}-start` });
      activeParts.set(key, { id, type });
    }
    return true;
  };

  const closePart = (type, id) => {
    const key = partKey(type, id);
    if (!activeParts.has(key)) {
      return;
    }
    write({ id, type: `${type}-end` });
    activeParts.delete(key);
    closedParts.add(key);
    if (autoPartIds[type] === id) {
      autoPartIds[type] = null;
    }
  };

  const writeDeltaNow = (type, id, delta) => {
    if (!delta || textLimited || abortSignal?.aborted) {
      return;
    }
    const remaining = maxTextChars - streamedChars;
    const text = delta.length > remaining ? delta.slice(0, remaining) : delta;
    if (text && openPart(type, id)) {
      write({ delta: text, id, type: `${type}-delta` });
      streamedChars += text.length;
    }
    if (text.length < delta.length) {
      textLimited = true;
      closePart(type, id);
      const noticeId = `${provider}-output-limit`;
      openPart("text", noticeId);
      write({
        delta: `\n\n[${label} output stopped after ${maxTextChars.toLocaleString()} characters to keep Dream responsive.]`,
        id: noticeId,
        type: "text-delta",
      });
      closePart("text", noticeId);
    }
  };

  const flushPending = () => {
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    if (!pending.text || !pending.type) {
      return;
    }
    const { id, text, type } = pending;
    pending.text = "";
    pending.type = null;
    pending.id = null;
    writeDeltaNow(type, id, text);
  };

  // Auto-id prose: consecutive deltas of one kind share a part, switching
  // kind closes the other kind's part, and deltas are coalesced briefly so
  // chatty providers do not flood the stream.
  const queueAutoDelta = (type, delta) => {
    if (!delta || abortSignal?.aborted) {
      return;
    }
    if (pending.type && pending.type !== type) {
      flushPending();
    }
    const otherType = type === "text" ? "reasoning" : "text";
    if (autoPartIds[otherType]) {
      closePart(otherType, autoPartIds[otherType]);
    }
    if (!autoPartIds[type]) {
      autoPartIds[type] = `${provider}-${type}-${Date.now()}`;
    }
    pending.type = type;
    pending.id = autoPartIds[type];
    pending.text += delta;
    if (pending.timer === null) {
      pending.timer = setTimeout(flushPending, TEXT_FLUSH_INTERVAL_MS);
    }
  };

  const prose = (type, delta, id) => {
    if (id) {
      flushPending();
      writeDeltaNow(type, id, delta);
      return;
    }
    queueAutoDelta(type, delta);
  };

  const closeText = () => {
    flushPending();
    for (const { id, type } of [...activeParts.values()]) {
      closePart(type, id);
    }
  };

  // Auto-id prose ends when a tool starts, so the tool renders after the
  // text it interrupts; provider-named parts end when the provider says so.
  const closeAutoParts = () => {
    flushPending();
    for (const type of ["reasoning", "text"]) {
      if (autoPartIds[type]) {
        closePart(type, autoPartIds[type]);
      }
    }
  };

  const buildMetadata = (extra = {}) => ({
    ...responseMessageMetadata,
    ...(sessionId
      ? {
          remoteConversationId: sessionId,
          remoteConversationModel: model,
          remoteConversationModelSpeed: modelSpeed,
          remoteConversationProjectPath: projectPath,
        }
      : {}),
    ...extra,
  });

  const metadata = (extra) => {
    write({ messageMetadata: buildMetadata(extra), type: "message-metadata" });
  };

  const toolStart = ({ input = {}, kind, title, toolCallId, toolName }) => {
    if (!toolCallId || startedTools.has(toolCallId)) {
      return false;
    }
    closeAutoParts();
    startedTools.add(toolCallId);
    const toolMetadata = getToolMetadata(toolName, kind);
    const base = {
      dynamic: true,
      providerExecuted: true,
      title: title || toolName,
      toolCallId,
      toolName,
      ...(toolMetadata ? { toolMetadata } : {}),
    };
    write({ ...base, type: "tool-input-start" });
    write({ ...base, input, type: "tool-input-available" });
    return true;
  };

  const toolOutput = (toolCallId, output) => {
    if (!toolCallId || completedTools.has(toolCallId)) {
      return false;
    }
    completedTools.add(toolCallId);
    write({
      dynamic: true,
      output,
      providerExecuted: true,
      toolCallId,
      type: "tool-output-available",
    });
    return true;
  };

  const toolError = (toolCallId, errorText) => {
    if (!toolCallId || completedTools.has(toolCallId)) {
      return false;
    }
    completedTools.add(toolCallId);
    write({
      dynamic: true,
      errorText: errorText || `${label} tool failed.`,
      providerExecuted: true,
      toolCallId,
      type: "tool-output-error",
    });
    return true;
  };

  return {
    get aborted() {
      return abortSignal?.aborted === true;
    },
    get signal() {
      return abortSignal;
    },
    get sessionId() {
      return sessionId;
    },
    get textLimited() {
      return textLimited;
    },

    text: (delta, id) => prose("text", delta, id),
    reasoning: (delta, id) => prose("reasoning", delta, id),
    /** Ends one explicit-id part; auto parts end when the kind switches. */
    endText: (id, type = "text") => {
      flushPending();
      closePart(type, id);
    },
    /** Flushes buffered prose and ends every open part. */
    closeText,
    /** Whether a part has already been written and ended. */
    hasEndedText: (id, type = "text") => closedParts.has(partKey(type, id)),

    toolStart,
    toolOutput,
    toolError,
    hasStartedTool: (toolCallId) => startedTools.has(toolCallId),

    /**
     * Shows the tool (if not shown yet), asks the user, and resolves with
     * their answer. `input` is what the user sees; `request` is what the
     * approval endpoint records (defaults to the input and tool name).
     */
    approval: async ({
      input = {},
      kind,
      request,
      signal,
      title,
      toolCallId,
      toolName,
    }) => {
      toolStart({ input, kind, title, toolCallId, toolName });
      const approvalId = formatApprovalId(provider, toolCallId);
      write({ approvalId, toolCallId, type: "tool-approval-request" });
      return waitForToolApproval({
        id: approvalId,
        provider,
        request: request ?? { input, toolName },
        signal: signal ?? abortSignal,
      });
    },

    /** Writes a plan update when the payload carries a list. */
    todos: (payload) => {
      const todos = getArrayFromPayload(payload);
      if (!todos) {
        return false;
      }
      flushPending();
      write({
        data: {
          explanation: isRecord(payload) ? (payload.explanation ?? null) : null,
          todos,
        },
        id: "todos",
        type: "data-todos",
      });
      return true;
    },

    /** A plan update carried by a todo-style tool call, if `item` is one. */
    todosFromTool(item) {
      if (!isTodoToolName(item?.name ?? item?.tool ?? item?.type)) {
        return false;
      }
      return (
        this.todos(item?.arguments) ||
        this.todos(item?.input) ||
        this.todos(item)
      );
    },

    compaction: (id, state) => {
      if (typeof id !== "string" || !id.trim()) {
        return false;
      }
      write({ data: { state }, id, type: "data-context-compaction" });
      return true;
    },

    /** Records the provider's session id; writes it unless told not to. */
    session: (id, { emit = true } = {}) => {
      const nextId = typeof id === "string" && id.trim() ? id.trim() : null;
      if (!nextId || nextId === sessionId) {
        return;
      }
      sessionId = nextId;
      if (emit) {
        metadata();
      }
    },
    buildMetadata,
    metadata,
    usage: (usage, contextWindow) => {
      const formatted = formatTurnUsage(usage);
      if (!formatted) {
        return;
      }
      metadata({
        ...(toFiniteNumber(contextWindow) ? { contextWindow } : {}),
        usage: formatted,
      });
    },

    merge: (stream) => writer.merge(stream.pipeThrough(stampToolKinds())),
  };
};

/**
 * Who is told about a turn's messages while it runs, whether or not any
 * client is reading it: the host, which saves the transcript at every step
 * and at the end. Set around a provider's `stream` call (chat-routes.js);
 * `streamAgentTurn` reads it, so no provider adapter has to know.
 * It is told the assistant message being written (continuing the last one
 * when the turn does).
 * @type {AsyncLocalStorage<{ onMessage: (message: unknown, options: { final: boolean }) => Promise<unknown> | unknown }>}
 */
export const turnObservers = new AsyncLocalStorage();

/**
 * Follows a copy of the turn's UI-message stream: the assistant message so
 * far, after every finished step and once at the end (also after an error
 * or a stop). A turn that continues the last assistant message builds on it.
 */
const observeTurn = async (stream, originalMessages, observer) => {
  const last = Array.isArray(originalMessages) ? originalMessages.at(-1) : null;
  const continued = last?.role === "assistant";
  let stepEnded = false;
  const marked = stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (chunk?.type === "finish-step") stepEnded = true;
        controller.enqueue(chunk);
      },
    }),
  );

  let latest = continued ? last : null;
  const report = async (final) => {
    if (!latest) return;
    try {
      await observer.onMessage(latest, { final });
    } catch (error) {
      console.warn("[turn] Saving the turn's messages failed.", error);
    }
  };

  try {
    for await (const message of readUIMessageStream({
      message: continued ? structuredClone(last) : undefined,
      onError: () => {},
      stream: marked,
    })) {
      latest = message;
      if (stepEnded) {
        stepEnded = false;
        await report(false);
      }
    }
  } catch (error) {
    console.warn("[turn] Following the turn's messages failed.", error);
  } finally {
    await report(true);
  }
};

/**
 * Runs `execute(turn)` inside a UI-message stream and returns the HTTP
 * response. The initial request metadata is written before `execute` runs,
 * open parts are closed after it, an error after the client aborted is
 * dropped, and any other error reaches the client formatted.
 */
export const streamAgentTurn = ({ execute, messages, ...turnOptions }) => {
  const { label = turnOptions.provider, provider } = turnOptions;
  const stream = createUIMessageStream({
    originalMessages: messages,
    onError: (error) => {
      console.error(`[${provider} stream error]`, error);
      return formatStreamError(error) || `${label} request failed.`;
    },
    execute: async ({ writer }) => {
      const turn = createAgentTurn({ writer, ...turnOptions });
      turn.metadata();
      try {
        await execute(turn);
      } catch (error) {
        if (!turn.aborted) {
          throw error;
        }
      } finally {
        turn.closeText();
      }
    },
  });

  const observer = turnObservers.getStore();
  if (!observer) {
    return createUIMessageStreamResponse({ stream });
  }
  const [toClient, toObserver] = stream.tee();
  void observeTurn(toObserver, messages, observer);
  return createUIMessageStreamResponse({ stream: toClient });
};
