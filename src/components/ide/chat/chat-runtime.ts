/**
 * The chat runtime: owns one AI SDK `Chat` per conversation, outside React.
 *
 * A chat streams, persists its transcript, answers approvals and picks up
 * queued submissions whether or not a `ChatPanel` is showing it. Panels are
 * views: they subscribe to the session's `Chat` with `useChat({ chat })`.
 *
 * The store never imports this module (it would be a cycle). Store actions ask
 * for a submission by queueing it in `pendingChatSubmitByChatId`; the runtime
 * watches that queue and sends.
 */
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import { create } from "zustand";
import { ApiError, apiClient } from "@/lib/api-client";
import {
  forgetChatQueue,
  refreshChatQueue,
  useChatQueueStore,
} from "@/lib/chat-queue";
import {
  hostRequestOptions,
  reportHostResponse,
} from "@/lib/connections/host-endpoint";
import {
  connectionRecovery,
  connectionSupervisor,
} from "@/lib/connections/runtime";
import { resolveRequestHost } from "@/lib/host-routing";
import { getDefaultGitGenerationModelSelection } from "@/lib/ide-defaults";
import { resolveEffectiveMcpServers } from "@/lib/mcp-servers";
import type {
  AiProvider,
  PendingChatSubmit,
  ProjectReference,
} from "@/types/ide";
import { isAiSdkApproval } from "../../../../electron/shared/agent-turn-contract.js";
import { getProviderCapabilities } from "../../../../electron/shared/provider-capabilities.js";
import { getActivityAttention } from "../activity-status";
import { useActivityStore } from "../activity-store";
import { getChipToolKind } from "../assistant-message-tools";
import { mergeChatMessageHistories } from "../chat-message-history";
import { warmProjectCommitMessage } from "../git-generated-text";
import { chatIsAwaitingAnswer } from "../header/project-tab-status";
import { useIdeStore } from "../ide-store";
import { normalizeModelSpeed } from "../ide-types";
import {
  flushProjectPanelRefresh,
  scheduleProjectPanelRefresh,
} from "../project-panel-refresh";
import { isHostAway } from "../ssh/host-away";
import { ensureHostChat } from "../store/ide-store-persistence";
import {
  addAskUserQuestionAnswerToMessages,
  preserveAskUserQuestionAnswers,
} from "./ask-user-question-answers";
import {
  CHAT_STREAM_UPDATE_THROTTLE_MS,
  PROVIDER_LABELS,
} from "./chat-constants";
import {
  getChatModelOptions,
  resolveChatModelSelection,
} from "./chat-model-selection";
import {
  hasPossibleSkillMention,
  type SerializedComposerDraft,
  serializeComposerDraft,
} from "./composer-draft";
import type { ChatMessageMetadata } from "./message-footer";
import { fetchProviderSkills, providerSupportsSkills } from "./provider-skills";
import { projectMessagesForRequest } from "./request-context";
import type { ToolApprovalResponder } from "./tool-call-groups";
import {
  createTurnStreamCache,
  TurnStreamMismatchError,
} from "./turn-stream-cache";

/** How long an unwatched, idle session is kept before it is dropped. */
export const CHAT_SESSION_IDLE_EVICT_MS = 30_000;
const MIN_STREAM_RETRY_MS = 250;
const MAX_STREAM_RETRY_MS = 5_000;

// ── Translations ────────────────────────────────────────────────────────
// The runtime has no React context. `ChatRuntimeHost` hands it the current
// translators; until then (and in tests) it falls back to English.

type Translate = (key: string, values?: Record<string, string>) => string;

interface ChatRuntimeTranslators {
  chat: Translate;
  models: Translate;
}

const FALLBACK_CHAT_MESSAGES: Record<string, string> = {
  alreadyStreaming: "Chat response is already streaming.",
  enableModelFirst: "Enable at least one model in Settings first.",
  notInActiveProject:
    "This chat is no longer in the active project. Switch back to this project and try again.",
  providerCliUnavailable:
    "{provider} CLI is not available. Check Settings > Providers.",
  unexpectedError:
    "An unexpected error occurred. Check the developer console for details.",
};

let translators: ChatRuntimeTranslators | null = null;

export const setChatRuntimeTranslators = (
  next: ChatRuntimeTranslators | null,
) => {
  translators = next;
};

const chatT: Translate = (key, values) => {
  if (translators) {
    return translators.chat(key, values);
  }
  return Object.entries(values ?? {}).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    FALLBACK_CHAT_MESSAGES[key] ?? key,
  );
};

const modelT: Translate = (key) => translators?.models(key) ?? key;

// ── Errors shown in a chat's banner ─────────────────────────────────────

interface ChatRuntimeState {
  /** Text a failed queued submission hands back to the chat's draft. */
  draftRestoreByChatId: Record<string, string>;
  errorByChatId: Record<string, string>;
}

export const useChatRuntimeStore = create<ChatRuntimeState>(() => ({
  draftRestoreByChatId: {},
  errorByChatId: {},
}));

const withoutKey = <Value>(record: Record<string, Value>, key: string) => {
  if (!Object.hasOwn(record, key)) {
    return record;
  }
  const { [key]: _removed, ...rest } = record;
  return rest;
};

export const setChatError = (chatId: string, message: string | null) => {
  useChatRuntimeStore.setState((state) => ({
    errorByChatId: message
      ? { ...state.errorByChatId, [chatId]: message }
      : withoutKey(state.errorByChatId, chatId),
  }));
};

/** Clears the banner and the `Chat`'s own error state. */
export const dismissChatError = (chatId: string) => {
  setChatError(chatId, null);
  sessions.get(chatId)?.chat.clearError();
};

/** Takes the text a failed queued submission left for the chat's draft. */
export const takeChatDraftRestore = (chatId: string) => {
  const text = useChatRuntimeStore.getState().draftRestoreByChatId[chatId];
  if (text === undefined) {
    return null;
  }
  useChatRuntimeStore.setState((state) => ({
    draftRestoreByChatId: withoutKey(state.draftRestoreByChatId, chatId),
  }));
  return text;
};

// ── Sessions ────────────────────────────────────────────────────────────

export interface ChatSession {
  readonly chat: Chat<UIMessage>;
  readonly chatId: string;
}

interface InternalChatSession extends ChatSession {
  evictTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryDelay: number;
  reconnectNeeded: boolean;
  lastFlushedMessages: UIMessage[];
  /** Metadata captured at submit, merged into the turn's final message. */
  pendingAssistantMetadata: ChatMessageMetadata | null;
  refreshedWriteEvents: Set<string>;
  releaseTranscript: () => void;
  /** Panels (or other watchers) currently showing this session. */
  retainCount: number;
  unsubscribeMessages: () => void;
}

const sessions = new Map<string, InternalChatSession>();
const draining = new Set<string>();
const submissions = new Map<string, Promise<boolean>>();

/** A session's `Chat` id is `chat:<chatId>`; the host knows the chat id. */
const CHAT_ID_PREFIX = "chat:";
const toHostChatId = (sessionId: string) =>
  sessionId.startsWith(CHAT_ID_PREFIX)
    ? sessionId.slice(CHAT_ID_PREFIX.length)
    : sessionId;

/**
 * The transport's network: never follows a redirect (the request carries a
 * host's credential), and tells the connection supervisor what the host
 * answered. The host is named by the header the request options set.
 */
const CHAT_HOST_HEADER = "x-dream-chat-host";
/** The chat a turn stream belongs to, for the turn stream cache. */
const CHAT_STREAM_HEADER = "x-dream-chat-stream";
class ChatStreamUnavailableError extends Error {}

/**
 * The bytes of running turns read so far: a reconnect downloads only what
 * follows them (turn-stream-cache.ts).
 */
const turnStreams = createTurnStreamCache();

const chatFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  const hostId = headers.get(CHAT_HOST_HEADER);
  const streamChatId = headers.get(CHAT_STREAM_HEADER);
  headers.delete(CHAT_HOST_HEADER);
  headers.delete(CHAT_STREAM_HEADER);
  // A reconnect asks for what follows the bytes this window holds.
  const resume =
    streamChatId &&
    typeof input === "string" &&
    (init?.method ?? "GET").toUpperCase() === "GET"
      ? turnStreams.cursor(streamChatId)
      : null;
  const target =
    resume && typeof input === "string"
      ? turnStreams.resumeUrl(input, resume)
      : input;
  let response: Response;
  try {
    response = await fetch(target, {
      ...init,
      headers,
      redirect: "error",
    });
    if (hostId) reportHostResponse(hostId, response);
    if (
      response.status >= 500 ||
      response.status === 408 ||
      response.status === 429
    ) {
      await response.body?.cancel();
      throw new ChatStreamUnavailableError(
        `Chat stream unavailable (${response.status}).`,
      );
    }
  } catch (error) {
    if (
      hostId &&
      !(error instanceof DOMException && error.name === "AbortError")
    ) {
      connectionSupervisor.report(
        hostId,
        "unreachable",
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
  if (!streamChatId) return response;
  try {
    return turnStreams.read(streamChatId, response, resume);
  } catch (error) {
    if (!(error instanceof TurnStreamMismatchError)) throw error;
    // Asked again, the host sends the whole turn.
    throw new ChatStreamUnavailableError(error.message);
  }
};

/**
 * The URL, credential and headers of a chat request to `hostId`; with
 * `chatId`, its answer is a turn stream the turn stream cache keeps.
 */
const chatRequestOptions = (hostId: string, path: string, chatId?: string) => {
  const options = hostRequestOptions(hostId, path);
  return {
    ...options,
    headers: {
      ...options.headers,
      [CHAT_HOST_HEADER]: hostId,
      ...(chatId ? { [CHAT_STREAM_HEADER]: chatId } : {}),
    },
  };
};

class HostChatTransport extends DefaultChatTransport<UIMessage> {
  // The host replays from the start, including the same assistant message ID.
  // Reset the SDK's partial message so reconnecting does not duplicate parts.
  readonly resumeStreamIsReplay = true;
}

const transport = new HostChatTransport({
  api: "/api/chat",
  fetch: chatFetch,
  // A turn runs on the host, detached from the request: reconnecting asks
  // for the running turn's stream (204 when none runs), from where this
  // window's copy of it stops (chatFetch).
  prepareReconnectToStreamRequest: ({ id }) => {
    const chatId = toHostChatId(id);
    return chatRequestOptions(
      resolveRequestHost({ chatId }),
      `/api/chat/${encodeURIComponent(chatId)}/stream`,
      chatId,
    );
  },
  prepareSendMessagesRequest: ({
    body,
    id,
    messageId,
    messages: requestMessages,
    trigger,
  }) => ({
    // To the host of the chat's project, with its credential.
    ...chatRequestOptions(
      resolveRequestHost({ chatId: toHostChatId(id) }),
      "/api/chat",
      toHostChatId(id),
    ),
    body: {
      ...body,
      id,
      messageId,
      messages: projectMessagesForRequest(requestMessages),
      trigger,
    },
  }),
});

const isChatProcessing = (chat: Chat<UIMessage>) =>
  chat.status === "submitted" || chat.status === "streaming";

const findChatConfig = (chatId: string) =>
  useIdeStore.getState().chats.find((chat) => chat.id === chatId);

const handleSessionError = (session: InternalChatSession, error: Error) => {
  // Provider errors arrive as ordinary Errors. A fetch/body failure means
  // only this observer was lost; the host still owns the turn.
  if (
    error instanceof TypeError ||
    error instanceof ChatStreamUnavailableError ||
    (error instanceof ApiError &&
      (error.status >= 500 || error.status === 408 || error.status === 429))
  ) {
    session.reconnectNeeded = true;
    setChatError(session.chatId, error.message);
    connectionSupervisor.report(
      resolveRequestHost({ chatId: session.chatId }),
      "unreachable",
      error.message,
    );
    return;
  }
  session.reconnectNeeded = false;
  handleChatError(session.chatId, error);
};

const handleChatError = (chatId: string, error: Error) => {
  useActivityStore.getState().finish(chatId, "failed", error.message);
  console.error("[chat error]", error);

  // The server-side onError already enriches the message, so error.message
  // should be descriptive. Guard against edge cases where only the generic
  // class name "Error" comes through.
  const message = error.message;
  if (message && message !== "Error") {
    setChatError(chatId, message);
    return;
  }

  if (error.cause instanceof Error && error.cause.message) {
    setChatError(chatId, error.cause.message);
    return;
  }

  setChatError(chatId, chatT("unexpectedError"));
};

const handleChatFinish = (
  session: InternalChatSession,
  {
    isAbort,
    isDisconnect,
    isError,
    message,
  }: {
    isAbort: boolean;
    isDisconnect: boolean;
    isError: boolean;
    message: UIMessage;
  },
) => {
  const { chat, chatId } = session;
  if (isDisconnect || (isError && session.reconnectNeeded)) {
    session.reconnectNeeded = true;
    flushSession(session);
    return;
  }
  const attention = getActivityAttention([message]);
  if (!isAbort && !isError && !isDisconnect && attention !== null) {
    useActivityStore.getState().attention(chatId, attention);
  } else {
    useActivityStore
      .getState()
      .finish(
        chatId,
        isError
          ? "failed"
          : isAbort || isDisconnect
            ? "interrupted"
            : "finished",
      );
  }

  const metadata = message.metadata as ChatMessageMetadata | undefined;
  const pendingMetadata = session.pendingAssistantMetadata;
  session.pendingAssistantMetadata = null;
  const completedAt = new Date().toISOString();
  const messageMetadata =
    (message.metadata as Record<string, unknown> | undefined) ?? {};
  const finalAssistantMessage: UIMessage = {
    ...message,
    metadata: {
      ...messageMetadata,
      ...(pendingMetadata ?? {}),
      ...(metadata?.usage ? { usage: metadata.usage } : {}),
      completedAt:
        typeof metadata?.completedAt === "string" && metadata.completedAt
          ? metadata.completedAt
          : completedAt,
      createdAt:
        typeof metadata?.createdAt === "string" && metadata.createdAt
          ? metadata.createdAt
          : pendingMetadata?.createdAt || completedAt,
      startedAt:
        typeof metadata?.startedAt === "string" && metadata.startedAt
          ? metadata.startedAt
          : pendingMetadata?.startedAt ||
            pendingMetadata?.createdAt ||
            (typeof metadata?.createdAt === "string" && metadata.createdAt
              ? metadata.createdAt
              : completedAt),
    },
  };

  const latestMessages = chat.messages;
  const nextMessages = mergeChatMessageHistories(
    latestMessages,
    preserveAskUserQuestionAnswers([finalAssistantMessage], latestMessages),
  );
  chat.messages = nextMessages;
  // The `Chat` keeps its own copy of the array, so read it back: that copy is
  // what a later flush compares against.
  session.lastFlushedMessages = chat.messages;
  useIdeStore.getState().setMessagesForChat(chatId, nextMessages);

  const remoteConversationId = metadata?.remoteConversationId?.trim();
  if (!remoteConversationId) {
    return;
  }

  useIdeStore.getState().updateChat(chatId, (current) => {
    const state = useIdeStore.getState();
    const projectPath = [...state.projects, ...state.closedProjects].find(
      (project) => project.id === current.projectId,
    )?.path;

    return {
      ...current,
      remoteConversationId,
      remoteConversationModel:
        metadata?.remoteConversationModel ?? current.model,
      remoteConversationModelSpeed: normalizeModelSpeed(
        metadata?.remoteConversationModelSpeed ?? current.modelSpeed,
      ),
      remoteConversationProjectPath:
        metadata?.remoteConversationProjectPath ??
        projectPath ??
        current.remoteConversationProjectPath,
    };
  });
};

/** Reacts to every (throttled) change of a session's messages. */
const observeSessionMessages = (session: InternalChatSession) => {
  const { chat, chatId } = session;
  const messages = chat.messages;
  if (chat.status === "streaming") {
    session.retryDelay = MIN_STREAM_RETRY_MS;
    if (session.reconnectNeeded) {
      session.reconnectNeeded = false;
      dismissChatError(chatId);
    }
  }

  useIdeStore
    .getState()
    .setChatAwaitingAnswer(chatId, chatIsAwaitingAnswer(messages));
  useActivityStore.getState().attention(chatId, getActivityAttention(messages));

  const config = findChatConfig(chatId);

  // Only the live tail can gain new write results. Avoid walking the entire
  // transcript on every stream update, then coalesce bursts across every chat
  // in the project before refreshing Git and the file tree.
  const latestMessage = messages.at(-1);
  if (config && latestMessage?.role === "assistant") {
    let shouldRefreshProjectPanels = false;
    latestMessage.parts.forEach((part, partIndex) => {
      if (
        getChipToolKind(part) !== "write" ||
        (part as Record<string, unknown>).state !== "output-available"
      ) {
        return;
      }

      const writeRefreshKey = `${chatId}:${latestMessage.id}:${partIndex}`;
      if (!session.refreshedWriteEvents.has(writeRefreshKey)) {
        session.refreshedWriteEvents.add(writeRefreshKey);
        shouldRefreshProjectPanels = true;
      }
    });

    if (shouldRefreshProjectPanels) {
      scheduleProjectPanelRefresh(config.projectId);
    }
  }
};

const isSessionBusy = (session: InternalChatSession) => {
  const state = useIdeStore.getState();
  const { chatId } = session;
  return (
    isChatProcessing(session.chat) ||
    draining.has(chatId) ||
    Boolean(state.streamingChatIds[chatId]) ||
    Boolean(state.awaitingAnswerChatIds[chatId]) ||
    Boolean(state.pendingChatSubmitByChatId[chatId])
  );
};

const disposeSession = (session: InternalChatSession) => {
  if (sessions.get(session.chatId) !== session) {
    return;
  }

  sessions.delete(session.chatId);
  if (session.evictTimer !== null) {
    clearTimeout(session.evictTimer);
    session.evictTimer = null;
  }
  if (session.retryTimer !== null) {
    clearTimeout(session.retryTimer);
    session.retryTimer = null;
  }
  session.unsubscribeMessages();
  flushSession(session);
  session.releaseTranscript();
  useIdeStore.getState().setChatAwaitingAnswer(session.chatId, false);
  setChatError(session.chatId, null);
};

const scheduleEviction = (session: InternalChatSession) => {
  if (session.evictTimer !== null || session.retainCount > 0) {
    return;
  }

  session.evictTimer = setTimeout(() => {
    session.evictTimer = null;
    if (session.retainCount > 0) {
      return;
    }
    if (isSessionBusy(session)) {
      // Looked at again when the turn ends (see `submitChatPrompt`).
      return;
    }
    disposeSession(session);
  }, CHAT_SESSION_IDLE_EVICT_MS);
};

/** The session for `chatId`, created on first use. */
export const getChatSession = (chatId: string): ChatSession => {
  const existing = sessions.get(chatId);
  if (existing) {
    return existing;
  }

  startChatRuntime();

  const initialMessages = useIdeStore.getState().messagesByChatId[chatId] ?? [];
  const session: InternalChatSession = {
    chat: new Chat<UIMessage>({
      id: `chat:${chatId}`,
      messages: initialMessages,
      onError: (error) => handleSessionError(session, error),
      onFinish: (options) => handleChatFinish(session, options),
      transport,
    }),
    chatId,
    evictTimer: null,
    retryTimer: null,
    retryDelay: MIN_STREAM_RETRY_MS,
    reconnectNeeded: false,
    lastFlushedMessages: initialMessages,
    pendingAssistantMetadata: null,
    refreshedWriteEvents: new Set(),
    releaseTranscript: useIdeStore.getState().retainChatTranscript(chatId),
    retainCount: 0,
    unsubscribeMessages: () => {},
  };
  // The `Chat` copies the array it is given; compare flushes against its copy.
  session.lastFlushedMessages = session.chat.messages;
  session.unsubscribeMessages = session.chat["~registerMessagesCallback"](
    () => observeSessionMessages(session),
    CHAT_STREAM_UPDATE_THROTTLE_MS,
  );
  sessions.set(chatId, session);
  // A session nobody ends up watching (e.g. an abandoned render) is dropped.
  scheduleEviction(session);
  // A turn already running on the host (started by another window, or by
  // this one before a reload) is followed from where it is.
  resumeHostTurn(session);
  return session;
};

/**
 * Follows the host's running turn in this session's chat, unless this
 * session is already the one streaming it.
 */
const resuming = new Set<string>();
const pendingResumes = new Set<string>();
const resumeHostTurn = (session: InternalChatSession, newTurn = false) => {
  const { chatId } = session;
  if (newTurn && (isChatProcessing(session.chat) || resuming.has(chatId)))
    pendingResumes.add(chatId);
  if (
    !useIdeStore.getState().hostRunningChatIds[chatId] ||
    !connectionRecovery.canConnect(resolveRequestHost({ chatId })) ||
    isChatProcessing(session.chat) ||
    resuming.has(chatId)
  )
    return;
  if (session.retryTimer !== null) {
    clearTimeout(session.retryTimer);
    session.retryTimer = null;
  }
  resuming.add(chatId);
  pendingResumes.delete(chatId);
  void (async () => {
    await useIdeStore.getState().applyCatalogTranscript(chatId);
    if (
      sessions.get(chatId) !== session ||
      !useIdeStore.getState().hostRunningChatIds[chatId] ||
      !connectionRecovery.canConnect(resolveRequestHost({ chatId }))
    )
      return;
    const messages = useIdeStore.getState().messagesByChatId[chatId] ?? [];
    session.chat.messages = mergeChatMessageHistories(
      session.chat.messages,
      messages,
    );
    useIdeStore.getState().setChatStreaming(chatId, true);
    await session.chat.resumeStream();
    if (session.chat.status === "ready") {
      session.reconnectNeeded = false;
      dismissChatError(chatId);
      // A 204 or completed stream may have overtaken the socket's turn-end
      // event. Refresh the authoritative running set as well as the text.
      if (useIdeStore.getState().hostRunningChatIds[chatId])
        await useIdeStore
          .getState()
          .refreshHostCatalog(resolveRequestHost({ chatId }));
    }
  })()
    .catch((error: Error) => handleSessionError(session, error))
    .finally(() => {
      resuming.delete(chatId);
      if (sessions.get(chatId) !== session) return;
      useIdeStore.getState().setChatStreaming(chatId, false);
      const projectId = findChatConfig(chatId)?.projectId;
      if (projectId) flushProjectPanelRefresh(projectId);
      void useIdeStore.getState().applyCatalogTranscript(chatId);
      void refreshChatQueue(chatId);
      scheduleEviction(session);
      if (pendingResumes.delete(chatId)) {
        resumeHostTurn(session);
      } else if (
        session.reconnectNeeded &&
        useIdeStore.getState().hostRunningChatIds[chatId] &&
        connectionRecovery.canConnect(resolveRequestHost({ chatId }))
      ) {
        const delay = session.retryDelay;
        session.retryDelay = Math.min(delay * 2, MAX_STREAM_RETRY_MS);
        session.retryTimer = setTimeout(() => {
          session.retryTimer = null;
          resumeHostTurn(session);
        }, delay);
      }
    });
};

/**
 * Follows every running turn again, on a fresh stream: after the client was
 * suspended or offline, a stream that still looks open may be dead. A
 * stream being followed is dropped (only this window stops following it;
 * the host's turn runs on) and resumed from the host; one whose turn is
 * running but not followed is resumed.
 */
export const reattachChatStreams = (hostId: string) => {
  for (const session of sessions.values()) {
    if (resolveRequestHost({ chatId: session.chatId }) !== hostId) continue;
    if (isChatProcessing(session.chat) || resuming.has(session.chatId)) {
      pendingResumes.add(session.chatId);
      void session.chat.stop();
    } else {
      resumeHostTurn(session);
    }
  }
};

/**
 * Stops the chat's running turn on the host. Dropping the request (the AI
 * SDK's `stop`) only stops this window following it.
 */
export const stopChatTurn = (chatId: string) => {
  void apiClient.stopChatTurn({ chatId }).catch((error: unknown) => {
    console.warn(`Unable to stop the turn in chat ${chatId}.`, error);
  });
};

/**
 * Keeps the session alive while something shows it. Returns the release
 * function; an idle session is dropped a while after its last release.
 */
export const retainChatSession = (chatId: string) => {
  const session = getChatSession(chatId) as InternalChatSession;
  session.retainCount += 1;
  if (session.evictTimer !== null) {
    clearTimeout(session.evictTimer);
    session.evictTimer = null;
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    session.retainCount -= 1;
    flushSession(session);
    scheduleEviction(session);
  };
};

const flushSession = (session: InternalChatSession) => {
  const messages = session.chat.messages;
  if (messages.length === 0 || messages === session.lastFlushedMessages) {
    return;
  }

  session.lastFlushedMessages = messages;
  useIdeStore.getState().setMessagesForChat(session.chatId, messages);
};

/** Saves the session's latest messages when they have not been saved yet. */
export const flushChatSession = (chatId: string) => {
  const session = sessions.get(chatId);
  if (session) {
    flushSession(session);
  }
};

// ── Tool approvals ──────────────────────────────────────────────────────

export const respondToToolApproval = (
  chatId: string,
  response: Parameters<ToolApprovalResponder>[0],
) => {
  const session = getChatSession(chatId) as InternalChatSession;
  const { chat } = session;

  apiClient
    .toolApprovalResponse({
      chatId,
      approved: response.approved,
      id: response.id,
      reason: response.reason ?? null,
      scope: response.scope ?? "once",
    })
    .then((result) => {
      if (!result.handled) throw new Error(chatT("approvalExpired"));
      const messagesWithAnswer = addAskUserQuestionAnswerToMessages(
        chat.messages,
        response,
      );
      if (messagesWithAnswer !== chat.messages) {
        chat.messages = messagesWithAnswer;
        session.lastFlushedMessages = chat.messages;
        useIdeStore.getState().setMessagesForChat(chatId, messagesWithAnswer);
      }
      if (!isAiSdkApproval(response.id)) {
        void Promise.resolve(
          chat.addToolApprovalResponse({
            approved: response.approved,
            id: response.id,
            reason: response.reason,
          }),
        ).catch((error: unknown) =>
          console.debug("[tool approval ai-sdk response]", error),
        );
      }
    })
    .catch((error) => {
      handleChatError(chatId, error);
      console.error("[tool approval response]", error);
    });
};

// ── Submitting ──────────────────────────────────────────────────────────

export interface ChatPromptSubmission {
  files: FileUIPart[];
  references?: ProjectReference[];
  /** `$skill` names the composer recognised; shown on the sent message. */
  skills?: string[];
  text: string;
}

const formatProjectReferencesForPrompt = (references: ProjectReference[]) =>
  references
    .map((reference) => `- ${reference.kind}: ${reference.path}`)
    .join("\n");

const generateChatTitle = ({
  chatId,
  fallbackModel,
  projectPath,
  promptText,
  provider,
  titleBeforeGeneration,
}: {
  chatId: string;
  fallbackModel: string;
  projectPath: string;
  promptText: string;
  provider: AiProvider;
  titleBeforeGeneration: string;
}) => {
  useIdeStore.getState().setChatTitleGenerating(chatId, true);
  void apiClient
    .chatTitle({ fallbackModel, projectPath, promptText, provider })
    .then((payload) => payload.title.trim())
    .then((generatedTitle) => {
      if (!generatedTitle) {
        return;
      }
      useIdeStore
        .getState()
        .updateChat(chatId, (current) =>
          current.title === titleBeforeGeneration
            ? { ...current, title: generatedTitle }
            : current,
        );
    })
    .catch(() => {
      // Keep the default title when background title generation fails.
    })
    .finally(() => {
      useIdeStore.getState().setChatTitleGenerating(chatId, false);
    });
};

/**
 * Sends a prompt in `chatId`. Returns `true` once the message is on its way,
 * `false` when nothing was sent (the reason, if any, is on the chat's error
 * banner). Throws when the chat is already streaming or cannot run here.
 *
 * Synchronous on purpose: callers clear their draft right after it returns.
 * The chat's transcript must already be loaded.
 */
export const submitChatPrompt = (
  chatId: string,
  prompt: ChatPromptSubmission,
): Promise<boolean> | false => {
  const session = getChatSession(chatId) as InternalChatSession;
  const { chat } = session;

  setChatError(chatId, null);
  chat.clearError();

  const state = useIdeStore.getState();
  const config = state.chats.find((item) => item.id === chatId);
  const submittedProject = config
    ? state.projects.find((item) => item.id === config.projectId)
    : undefined;

  if (
    !config ||
    !submittedProject ||
    state.activeProjectId !== submittedProject.id
  ) {
    const message = chatT("notInActiveProject");
    setChatError(chatId, message);
    throw new Error(message);
  }

  // Its host is not there to run the turn.
  const away = isHostAway(state, submittedProject);
  if (away) {
    const message = chatT("hostNotConnected", { host: away.label });
    setChatError(chatId, message);
    throw new Error(message);
  }

  const { settings, providerModels } = state;
  const {
    selectedModel: activeModel,
    selectedModelOption: activeOption,
    selectedModelSpeed,
    selectedProvider: activeProvider,
    selectedReasoningEffort,
    availableModelSpeedTiers,
  } = resolveChatModelSelection(
    config,
    getChatModelOptions(settings, providerModels),
  );

  if (!(providerModels[activeProvider]?.installed ?? false)) {
    setChatError(
      chatId,
      chatT("providerCliUnavailable", {
        provider: PROVIDER_LABELS[activeProvider],
      }),
    );
    return false;
  }

  if (!activeModel) {
    setChatError(chatId, chatT("enableModelFirst"));
    return false;
  }

  const projectReferences = prompt.references ?? [];
  if (
    !prompt.text.trim() &&
    prompt.files.length === 0 &&
    projectReferences.length === 0
  ) {
    return false;
  }

  const submittedProjectPath = submittedProject.path;
  const modelLabel = activeOption?.label ?? activeModel;
  const selectionMetadata = {
    model: activeModel,
    modelLabel,
    modelSpeed: selectedModelSpeed,
    ...(availableModelSpeedTiers.length > 0
      ? { modelSpeedLabel: modelT(selectedModelSpeed) }
      : {}),
    ...(selectedReasoningEffort
      ? {
          reasoningEffort: selectedReasoningEffort,
          reasoningLabel: modelT(selectedReasoningEffort),
        }
      : {}),
  };

  const storedMessages = state.messagesByChatId[chatId] ?? [];
  const shouldGenerateTitle =
    storedMessages.length === 0 &&
    !config.messageCount &&
    config.title === "New chat";
  if (shouldGenerateTitle) {
    generateChatTitle({
      chatId,
      fallbackModel: activeModel,
      projectPath: submittedProjectPath,
      promptText:
        prompt.text || formatProjectReferencesForPrompt(projectReferences),
      provider: activeProvider,
      titleBeforeGeneration: config.title,
    });
  }
  const requestId = crypto.randomUUID();
  const message: UIMessage = {
    id: requestId,
    role: "user",
    parts: [
      ...prompt.files,
      ...(prompt.text ? [{ type: "text" as const, text: prompt.text }] : []),
    ],
    metadata: {
      createdAt: new Date().toISOString(),
      ...selectionMetadata,
      projectReferences,
      ...(prompt.skills?.length ? { skillMentions: prompt.skills } : {}),
    },
  };
  if (!message.parts.length)
    message.parts.push({
      type: "text",
      text: formatProjectReferencesForPrompt(projectReferences),
    });
  const sending = (submissions.get(chatId) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await ensureHostChat(submittedProject, config);
      const submission = {
        ...selectionMetadata,
        chatId,
        requestId,
        message: message as Parameters<
          typeof apiClient.submitChat
        >[0]["message"],
        checkpointsEnabled: settings.changeCheckpoints,
        mcpServers: getProviderCapabilities(activeProvider).mcp
          ? resolveEffectiveMcpServers(settings)
          : [],
        permissionMode: config.permissionMode,
        projectId: submittedProject.id,
        projectPath: submittedProjectPath,
        projectReferences,
        provider: activeProvider,
      };
      try {
        await apiClient.submitChat(submission);
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) throw error;
        // A lost receipt may hide a committed submission. Retry the exact ID;
        // the host returns its receipt without dispatching it twice.
        await apiClient.submitChat(submission);
      }
      await refreshChatQueue(chatId);
      // Very short turns can finish before a stream subscription is established.
      await useIdeStore.getState().applyCatalogTranscript(chatId);
      resumeHostTurn(session);
      return true;
    })
    .catch((error: unknown) => {
      setChatError(
        chatId,
        error instanceof Error ? error.message : chatT("unexpectedError"),
      );
      throw error;
    })
    .finally(() => {
      if (submissions.get(chatId) === sending) submissions.delete(chatId);
    });
  submissions.set(chatId, sending);
  return sending;
};

// ── Queued submissions ──────────────────────────────────────────────────

const isEmptySubmission = (submission: PendingChatSubmit) =>
  !submission.text.trim() &&
  submission.references.length === 0 &&
  !submission.files?.length;

const restoreDraft = (chatId: string, submission: PendingChatSubmit) => {
  if (!submission.preserveDraft) {
    return;
  }
  useChatRuntimeStore.setState((state) => ({
    draftRestoreByChatId: {
      ...state.draftRestoreByChatId,
      [chatId]: [state.draftRestoreByChatId[chatId], submission.text]
        .filter(Boolean)
        .join("\n\n"),
    },
  }));
};

/**
 * A queued prompt (a saved prompt, a stash item, review feedback) is sent
 * through the same serialization as the composer, so its `$skill` mentions
 * are recognised and shown on the message. Queued text is already
 * serialized; this recovers the skills. The catalog is only fetched when the
 * text could mention one, as the composer does.
 */
const serializeQueuedSubmission = async (
  chatId: string,
  submission: PendingChatSubmit,
): Promise<SerializedComposerDraft> => {
  const draft = { references: submission.references, text: submission.text };
  const state = useIdeStore.getState();
  const config = state.chats.find((item) => item.id === chatId);
  const project = config
    ? state.projects.find((item) => item.id === config.projectId)
    : undefined;
  if (!config || !project || !hasPossibleSkillMention(draft.text)) {
    return { ...draft, skills: [] };
  }

  const { selectedProvider } = resolveChatModelSelection(
    config,
    getChatModelOptions(state.settings, state.providerModels),
  );
  if (!providerSupportsSkills(selectedProvider)) {
    return { ...draft, skills: [] };
  }
  const { skills } = await fetchProviderSkills(selectedProvider, project.path);
  return serializeComposerDraft(draft, skills);
};

const drainPendingSubmit = async (chatId: string) => {
  if (draining.has(chatId)) {
    return;
  }

  draining.add(chatId);
  try {
    await useIdeStore.getState().loadRecentMessagesForChat(chatId);

    const state = useIdeStore.getState();
    if (!state.pendingChatSubmitByChatId[chatId]) {
      return;
    }

    const submission = state.takePendingChatSubmit(chatId);
    if (!submission || isEmptySubmission(submission)) {
      return;
    }

    try {
      const serialized = await serializeQueuedSubmission(chatId, submission);
      const submitted = await submitChatPrompt(chatId, {
        files: submission.files ?? [],
        ...serialized,
      });
      if (!submitted) {
        restoreDraft(chatId, submission);
      }
    } catch (error) {
      restoreDraft(chatId, submission);
      setChatError(
        chatId,
        error instanceof Error ? error.message : "Unable to send the message.",
      );
    }
  } catch {
    setChatError(chatId, chatT("unexpectedError"));
  } finally {
    draining.delete(chatId);
    const session = sessions.get(chatId);
    if (session) {
      scheduleEviction(session);
    }
  }
};

const drainPendingSubmits = () => {
  for (const chatId of Object.keys(
    useIdeStore.getState().pendingChatSubmitByChatId,
  )) {
    void drainPendingSubmit(chatId);
  }
};

// ── Store wiring ────────────────────────────────────────────────────────

/** Brings a session up to date with a transcript the store loaded or saved. */
const syncSessionFromStore = (
  session: InternalChatSession,
  storeMessages: UIMessage[],
) => {
  const merged = mergeChatMessageHistories(
    storeMessages,
    session.chat.messages,
  );
  if (!isChatProcessing(session.chat)) {
    session.chat.messages = storeMessages;
    session.lastFlushedMessages = session.chat.messages;
    return;
  }
  if (merged !== session.chat.messages) {
    session.chat.messages = merged;
  }
  if (merged === storeMessages) {
    // Nothing newer than what the store already holds.
    session.lastFlushedMessages = session.chat.messages;
  }
};

/**
 * Generates the commit message of each project whose last running turn has
 * just ended, so the Changes tab finds it ready. The host's running set is
 * the one signal every turn end reaches, whether this window followed the
 * turn's stream or not, and whenever its end arrives.
 */
const warmCommitMessagesOfSettledProjects = (
  state: ReturnType<typeof useIdeStore.getState>,
  previous: ReturnType<typeof useIdeStore.getState>,
) => {
  const endedProjectIds = new Set<string>();
  for (const chatId of Object.keys(previous.hostRunningChatIds)) {
    if (state.hostRunningChatIds[chatId]) continue;
    const projectId = state.chats.find((chat) => chat.id === chatId)?.projectId;
    if (projectId) endedProjectIds.add(projectId);
  }
  for (const projectId of endedProjectIds) {
    const project = state.projects.find((entry) => entry.id === projectId);
    if (
      !project ||
      state.chats.some(
        (chat) =>
          chat.projectId === projectId && state.hostRunningChatIds[chat.id],
      )
    )
      continue;
    void warmProjectCommitMessage({
      ...getDefaultGitGenerationModelSelection(state.settings),
      hostId: project.hostId,
      projectPath: project.path,
    });
  }
};

let stopRuntime: (() => void) | null = null;

/** Idempotent. Returns a function that stops the runtime (used by tests). */
export const startChatRuntime = () => {
  if (stopRuntime) {
    return stopRuntime;
  }

  const unsubscribe = useIdeStore.subscribe((state, previous) => {
    if (state.hostRunningChatIds !== previous.hostRunningChatIds) {
      for (const session of sessions.values()) {
        if (
          state.hostRunningChatIds[session.chatId] &&
          !previous.hostRunningChatIds[session.chatId]
        ) {
          resumeHostTurn(session, true);
        }
      }
      warmCommitMessagesOfSettledProjects(state, previous);
    }

    if (state.messagesByChatId !== previous.messagesByChatId) {
      for (const session of sessions.values()) {
        const storeMessages = state.messagesByChatId[session.chatId];
        if (
          storeMessages &&
          storeMessages !== previous.messagesByChatId[session.chatId]
        ) {
          syncSessionFromStore(session, storeMessages);
        }
      }
    }

    if (state.chats !== previous.chats) {
      const chatIds = new Set(state.chats.map((chat) => chat.id));
      for (const chatId of Object.keys(useChatQueueStore.getState().queues)) {
        if (!chatIds.has(chatId)) forgetChatQueue(chatId);
      }
      for (const session of [...sessions.values()]) {
        if (!chatIds.has(session.chatId)) {
          // The chat is gone for good (e.g. its worktree was purged).
          if (isChatProcessing(session.chat)) {
            void session.chat.stop();
          }
          disposeSession(session);
        }
      }
    }

    if (
      state.pendingChatSubmitByChatId !== previous.pendingChatSubmitByChatId ||
      state.streamingChatIds !== previous.streamingChatIds
    ) {
      drainPendingSubmits();
    }
  });

  const flushAll = () => {
    for (const session of sessions.values()) {
      flushSession(session);
    }
  };
  const hasWindow = typeof window !== "undefined";
  if (hasWindow) {
    window.addEventListener("blur", flushAll);
    window.addEventListener("pagehide", flushAll);
    window.addEventListener("beforeunload", flushAll);
  }

  stopRuntime = () => {
    stopRuntime = null;
    unsubscribe();
    if (hasWindow) {
      window.removeEventListener("blur", flushAll);
      window.removeEventListener("pagehide", flushAll);
      window.removeEventListener("beforeunload", flushAll);
    }
    for (const session of [...sessions.values()]) {
      disposeSession(session);
    }
  };

  drainPendingSubmits();
  return stopRuntime;
};
