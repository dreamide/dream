/**
 * The chat runtime: owns one AI SDK `Chat` per conversation, outside React.
 *
 * A chat streams, persists its transcript and answers approvals whether or
 * not a `ChatPanel` is showing it. Panels are
 * views of the session's **live transcript** (`getChatSessionView`,
 * `watchChatSessionView`): its messages, at most once per
 * CHAT_STREAM_UPDATE_THROTTLE_MS, and its status and error at once. The
 * session reads its `Chat` once per update for itself and every panel.
 *
 * Messages reach a chat through Chat submission (chat-submission.ts), which
 * decides whether the chat takes one and then starts its turn here
 * (`startChatTurn`). The store never imports this module (it would be a
 * cycle); it sends through the submitter that module registers with it.
 */
import { Chat } from "@ai-sdk/react";
import { DefaultChatTransport, type FileUIPart, type UIMessage } from "ai";
import { ApiError, apiClient } from "@/lib/api-client";
import {
  forgetChatQueue,
  refreshChatQueue,
  useChatQueueStore,
} from "@/lib/chat-queue";
import {
  fetchFromHost,
  hostRequestOptions,
  isTransientHostStatus,
} from "@/lib/connections/host-endpoint";
import {
  connectionRecovery,
  connectionSupervisor,
} from "@/lib/connections/runtime";
import { resolveRequestHost } from "@/lib/host-routing";
import { getDefaultGitGenerationModelSelection } from "@/lib/ide-defaults";
import { resolveEffectiveMcpServers } from "@/lib/mcp-servers";
import type { AiProvider, ProjectReference } from "@/types/ide";
import { isAiSdkApproval } from "../../../../electron/shared/agent-turn-contract.js";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import { getProviderCapabilities } from "../../../../electron/shared/provider-capabilities.js";
import { getActivityAttention } from "../activity-status";
import { getChipToolKind } from "../assistant-message-tools";
import { mergeChatMessageHistories } from "../chat-message-history";
import { chatTurnOutcomes } from "../chat-turn-outcome";
import { warmProjectCommitMessage } from "../git-generated-text";
import { chatIsAwaitingAnswer } from "../header/project-tab-status";
import { useIdeStore } from "../ide-store";
import { normalizeModelSpeed } from "../ide-types";
import {
  flushProjectPanelRefresh,
  scheduleProjectPanelRefresh,
} from "../project-panel-refresh";
import { catalogBaselines } from "../store/catalog-baselines";
import {
  addAskUserQuestionAnswerToMessages,
  preserveAskUserQuestionAnswers,
} from "./ask-user-question-answers";
import { CHAT_STREAM_UPDATE_THROTTLE_MS } from "./chat-constants";
import {
  getChatModelOptions,
  resolveChatModelSelection,
} from "./chat-model-selection";
import type { ChatMessageMetadata } from "./message-footer";
import { projectMessagesForRequest } from "./request-context";
import type { ToolApprovalResponder } from "./tool-call-groups";
import { createTurnFollowing } from "./turn-following";
import {
  createTurnStreamCache,
  TurnStreamMismatchError,
} from "./turn-stream-cache";

/** How long an unwatched, idle session is kept before it is dropped. */
export const CHAT_SESSION_IDLE_EVICT_MS = 30_000;

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
  hostNotConnected: "{host} is not connected. Send again once it is back.",
  messageStillSending: "A message to this chat is still being sent.",
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

/** A `chat` message in the current locale (English until `ChatRuntimeHost` runs). */
export const chatT: Translate = (key, values) => {
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
// The banner's message is the Chat turn outcome's (chat-turn-outcome.ts).

/** Clears the banner and the `Chat`'s own error state. */
export const dismissChatError = (chatId: string) => {
  chatTurnOutcomes.reportError(chatId, null);
  sessions.get(chatId)?.chat.clearError();
};

// ── Sessions ────────────────────────────────────────────────────────────

export interface ChatSession {
  readonly chat: Chat<UIMessage>;
  readonly chatId: string;
}

/** What a panel shows of a session; a new object only when one changed. */
export interface ChatSessionView {
  readonly error: Error | undefined;
  readonly messages: UIMessage[];
  readonly status: Chat<UIMessage>["status"];
}

interface InternalChatSession extends ChatSession {
  evictTimer: ReturnType<typeof setTimeout> | null;
  lastFlushedMessages: UIMessage[];
  /** Metadata captured at submit, merged into the turn's final message. */
  pendingAssistantMetadata: ChatMessageMetadata | null;
  refreshedWriteEvents: Set<string>;
  releaseTranscript: () => void;
  /** Panels (or other watchers) currently showing this session. */
  retainCount: number;
  unsubscribeMessages: () => void;
  /** The live transcript, as last published. */
  view: ChatSessionView;
  /** Shown panels, told when `view` changes. */
  viewWatchers: Set<() => void>;
}

const sessions = new Map<string, InternalChatSession>();

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
  // Sent as every request to a host is (host-endpoint.ts).
  const response = hostId
    ? await fetchFromHost(hostId, target, { ...init, headers })
    : await fetch(target, { ...init, headers, redirect: "error" });
  if (isTransientHostStatus(response.status)) {
    await response.body?.cancel();
    throw new ChatStreamUnavailableError(
      `Chat stream unavailable (${response.status}).`,
    );
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
    (error instanceof ApiError && isTransientHostStatus(error.status))
  ) {
    turnFollowing.lost(session.chatId);
    chatTurnOutcomes.reportError(session.chatId, error.message);
    connectionSupervisor.report(
      resolveRequestHost({ chatId: session.chatId }),
      "unreachable",
      error.message,
    );
    return;
  }
  turnFollowing.failed(session.chatId);
  handleChatError(session.chatId, error);
};

const handleChatError = (chatId: string, error: Error) => {
  console.error("[chat error]", error);

  // The server-side onError already enriches the message, so error.message
  // should be descriptive. Guard against edge cases where only the generic
  // class name "Error" comes through.
  const message =
    error.message && error.message !== "Error"
      ? error.message
      : error.cause instanceof Error && error.cause.message
        ? error.cause.message
        : chatT("unexpectedError");
  // On the banner at once; the turn's status once it has ended.
  chatTurnOutcomes.ended(chatId, "failed", message);
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
  if (isDisconnect || (isError && turnFollowing.isLost(chatId))) {
    turnFollowing.lost(chatId);
    flushSession(session);
    return;
  }
  // A stream that stalled after its turn ended was dropped: the turn is
  // done, and the follow settles on the saved transcript (onSettled).
  if (isAbort && turnFollowing.isEnded(chatId)) return;
  if (isError) chatTurnOutcomes.ended(chatId, "failed");
  else if (isAbort) chatTurnOutcomes.ended(chatId, "interrupted");
  else {
    // A turn that ends asking its user something waits on them.
    chatTurnOutcomes.attention(chatId, getActivityAttention([message]));
    chatTurnOutcomes.ended(chatId, "finished");
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

/**
 * Publishes the session's live transcript to its shown panels when it
 * changed. Runs on every (throttled) messages update and every status or
 * error change, whether or not a panel is shown.
 */
const publishSessionView = (session: InternalChatSession) => {
  const { chat, view } = session;
  if (
    view.messages === chat.messages &&
    view.status === chat.status &&
    view.error === chat.error
  )
    return;
  session.view = {
    error: chat.error,
    messages: chat.messages,
    status: chat.status,
  };
  for (const watcher of [...session.viewWatchers]) watcher();
};

/** Reacts to every (throttled) change of a session's messages. */
const observeSessionMessages = (session: InternalChatSession) => {
  const { chat, chatId } = session;
  const messages = chat.messages;
  // Bytes arrived: a stream lost before is live again.
  if (chat.status === "streaming" && turnFollowing.receiving(chatId)) {
    dismissChatError(chatId);
  }

  useIdeStore
    .getState()
    .setChatAwaitingAnswer(chatId, chatIsAwaitingAnswer(messages));
  chatTurnOutcomes.attention(chatId, getActivityAttention(messages));

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
    Boolean(state.streamingChatIds[chatId]) ||
    Boolean(state.awaitingAnswerChatIds[chatId])
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
  turnFollowing.forget(session.chatId);
  session.unsubscribeMessages();
  flushSession(session);
  session.releaseTranscript();
  useIdeStore.getState().setChatAwaitingAnswer(session.chatId, false);
  chatTurnOutcomes.reportError(session.chatId, null);
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
      // Looked at again when the turn ends (turn following's `onSettled`).
      return;
    }
    disposeSession(session);
  }, CHAT_SESSION_IDLE_EVICT_MS);
};

/**
 * The session's live transcript as last published: what a shown panel
 * renders. Reading it never sees a change the session has not published.
 */
export const getChatSessionView = (chatId: string): ChatSessionView =>
  (getChatSession(chatId) as InternalChatSession).view;

/**
 * Calls `onChange` whenever the session's live transcript is published
 * anew, until the returned function is called. A panel watches only while
 * it is shown.
 */
export const watchChatSessionView = (chatId: string, onChange: () => void) => {
  const session = getChatSession(chatId) as InternalChatSession;
  session.viewWatchers.add(onChange);
  return () => {
    session.viewWatchers.delete(onChange);
  };
};

const watchNothing = () => () => {};

/**
 * How a panel subscribes to its session's live transcript: while `visible`,
 * told of every published change; otherwise never.
 */
export const subscribeLiveTranscript =
  (chatId: string, visible: boolean) => (onChange: () => void) =>
    visible ? watchChatSessionView(chatId, onChange) : watchNothing();

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
    lastFlushedMessages: initialMessages,
    pendingAssistantMetadata: null,
    refreshedWriteEvents: new Set(),
    releaseTranscript: useIdeStore.getState().retainChatTranscript(chatId),
    retainCount: 0,
    unsubscribeMessages: () => {},
    view: { error: undefined, messages: initialMessages, status: "ready" },
    viewWatchers: new Set(),
  };
  // The `Chat` copies the array it is given; compare flushes against its copy.
  session.lastFlushedMessages = session.chat.messages;
  publishSessionView(session);
  const unsubscribes = [
    session.chat["~registerMessagesCallback"](() => {
      publishSessionView(session);
      observeSessionMessages(session);
    }, CHAT_STREAM_UPDATE_THROTTLE_MS),
    session.chat["~registerStatusCallback"](() => publishSessionView(session)),
    session.chat["~registerErrorCallback"](() => publishSessionView(session)),
  ];
  session.unsubscribeMessages = () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
  sessions.set(chatId, session);
  // A session nobody ends up watching (e.g. an abandoned render) is dropped.
  scheduleEviction(session);
  // A turn already running on the host (started by another window, or by
  // this one before a reload) is followed from where it is.
  turnFollowing.follow(session);
  return session;
};

/**
 * Following host turns into sessions (turn-following.ts): what a follow
 * does is this runtime's.
 */
const turnFollowing = createTurnFollowing<InternalChatSession>({
  canFollow: (chatId) =>
    Boolean(useIdeStore.getState().hostRunningChatIds[chatId]) &&
    connectionRecovery.canConnect(resolveRequestHost({ chatId })),
  isCurrent: (session) => sessions.get(session.chatId) === session,
  isStreaming: (session) => isChatProcessing(session.chat),
  stopStream: (session) => void session.chat.stop(),
  hostOf: (chatId) => resolveRequestHost({ chatId }),
  follow: async (session) => {
    const { chatId } = session;
    await useIdeStore.getState().applyCatalogTranscript(chatId);
    if (
      sessions.get(chatId) !== session ||
      !useIdeStore.getState().hostRunningChatIds[chatId] ||
      !connectionRecovery.canConnect(resolveRequestHost({ chatId }))
    )
      return false;
    const messages = useIdeStore.getState().messagesByChatId[chatId] ?? [];
    session.chat.messages = mergeChatMessageHistories(
      session.chat.messages,
      messages,
    );
    useIdeStore.getState().setChatStreaming(chatId, true);
    chatTurnOutcomes.started(chatId);
    await session.chat.resumeStream();
    if (session.chat.status !== "ready") return false;
    dismissChatError(chatId);
    // A 204 or completed stream may have overtaken the socket's turn-end
    // event. Refresh the authoritative running set as well as the text.
    if (useIdeStore.getState().hostRunningChatIds[chatId])
      await useIdeStore
        .getState()
        .refreshHostCatalog(resolveRequestHost({ chatId }));
    return true;
  },
  onError: (session, error) => handleSessionError(session, error),
  onSettled: (session) => {
    const { chatId } = session;
    // Dropped after its turn ended: finished. Otherwise this window only
    // stopped following, and the host says how the turn ends.
    chatTurnOutcomes.ended(
      chatId,
      turnFollowing.isEnded(chatId) ? "finished" : undefined,
    );
    useIdeStore.getState().setChatStreaming(chatId, false);
    const projectId = findChatConfig(chatId)?.projectId;
    if (projectId) flushProjectPanelRefresh(projectId);
    void useIdeStore.getState().applyCatalogTranscript(chatId);
    void refreshChatQueue(chatId);
    scheduleEviction(session);
  },
});

/**
 * Follows every running turn again, on a fresh stream: after the client was
 * suspended or offline, a stream that still looks open may be dead. A
 * stream being followed is dropped (only this window stops following it;
 * the host's turn runs on) and resumed from the host; one whose turn is
 * running but not followed is resumed.
 */
export const reattachChatStreams = (hostId: string) => {
  turnFollowing.reattach(hostId, sessions.values());
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

// ── Starting a turn ─────────────────────────────────────────────────────

/** A message ready for the host: serialized, with the skills it mentions. */
export interface ChatTurnPrompt {
  files: FileUIPart[];
  references: ProjectReference[];
  /** `$skill` names the text mentions; shown on the sent message. */
  skills: string[];
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
 * Sends `prompt` to the chat's host as a new turn and follows the turn here.
 * Resolves once the host has the message; rejects when it does not.
 *
 * Only Chat submission (chat-submission.ts) calls this, after its gate has
 * let the message through and the chat's transcript is loaded.
 */
export const startChatTurn = async (
  chatId: string,
  prompt: ChatTurnPrompt,
): Promise<void> => {
  const session = getChatSession(chatId) as InternalChatSession;
  const state = useIdeStore.getState();
  const config = state.chats.find((item) => item.id === chatId);
  const project = config
    ? state.projects.find((item) => item.id === config.projectId)
    : undefined;
  if (!config || !project) throw new Error(chatT("notInActiveProject"));

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
  if (!activeModel) throw new Error(chatT("enableModelFirst"));

  const projectReferences = prompt.references;
  const selectionMetadata = {
    model: activeModel,
    modelLabel: activeOption?.label ?? activeModel,
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
  if (
    storedMessages.length === 0 &&
    !config.messageCount &&
    config.title === "New chat"
  ) {
    generateChatTitle({
      chatId,
      fallbackModel: activeModel,
      projectPath: project.path,
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
      ...(prompt.skills.length ? { skillMentions: prompt.skills } : {}),
    },
  };
  if (!message.parts.length)
    message.parts.push({
      type: "text",
      text: formatProjectReferencesForPrompt(projectReferences),
    });

  await catalogBaselines.ensureChat(project, config);
  const submission = {
    ...selectionMetadata,
    chatId,
    requestId,
    message: message as Parameters<typeof apiClient.submitChat>[0]["message"],
    checkpointsEnabled: settings.changeCheckpoints,
    mcpServers: getProviderCapabilities(activeProvider).mcp
      ? resolveEffectiveMcpServers(settings)
      : [],
    permissionMode: config.permissionMode,
    projectId: project.id,
    projectPath: project.path,
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
  turnFollowing.follow(session);
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
      hostId: getProjectHostId(project),
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
          turnFollowing.follow(session, { newTurn: true });
        } else if (
          !state.hostRunningChatIds[session.chatId] &&
          previous.hostRunningChatIds[session.chatId]
        ) {
          turnFollowing.ended(session.chatId);
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

  return stopRuntime;
};
