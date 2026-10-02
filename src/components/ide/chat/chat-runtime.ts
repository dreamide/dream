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
import { apiClient } from "@/lib/api-client";
import { hostApiPath, resolveRequestHost } from "@/lib/host-routing";
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
import { warmProjectCommitMessage } from "../git-commit-message-cache";
import { chatIsAwaitingAnswer } from "../header/project-tab-status";
import { useIdeStore } from "../ide-store";
import { normalizeModelSpeed } from "../ide-types";
import {
  flushProjectPanelRefresh,
  scheduleProjectPanelRefresh,
} from "../project-panel-refresh";
import { isHostAway } from "../ssh/host-away";
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

/** A session's `Chat` id is `chat:<chatId>`; the host knows the chat id. */
const CHAT_ID_PREFIX = "chat:";
const toHostChatId = (sessionId: string) =>
  sessionId.startsWith(CHAT_ID_PREFIX)
    ? sessionId.slice(CHAT_ID_PREFIX.length)
    : sessionId;

const transport = new DefaultChatTransport<UIMessage>({
  api: "/api/chat",
  // A turn runs on the host, detached from the request: reconnecting asks
  // for the running turn's stream from its start (204 when none runs).
  prepareReconnectToStreamRequest: ({ id }) => {
    const chatId = toHostChatId(id);
    return {
      api: hostApiPath(
        resolveRequestHost({ chatId }),
        `/api/chat/${encodeURIComponent(chatId)}/stream`,
      ),
    };
  },
  prepareSendMessagesRequest: ({
    body,
    id,
    messageId,
    messages: requestMessages,
    trigger,
  }) => ({
    // To the host of the chat's project.
    api: hostApiPath(
      resolveRequestHost({ chatId: toHostChatId(id) }),
      "/api/chat",
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
  void useIdeStore.getState().persistMessagesForChat(chatId, nextMessages);

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
      onError: (error) => handleChatError(chatId, error),
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
const resumeHostTurn = (session: InternalChatSession) => {
  if (
    !useIdeStore.getState().hostRunningChatIds[session.chatId] ||
    isChatProcessing(session.chat)
  ) {
    return;
  }
  void session.chat.resumeStream();
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
  void useIdeStore.getState().persistMessagesForChat(session.chatId, messages);
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

  const messagesWithAnswer = addAskUserQuestionAnswerToMessages(
    chat.messages,
    response,
  );
  if (messagesWithAnswer !== chat.messages) {
    chat.messages = messagesWithAnswer;
    session.lastFlushedMessages = chat.messages;
    void useIdeStore
      .getState()
      .persistMessagesForChat(chatId, messagesWithAnswer);
  }

  if (!isAiSdkApproval(response.id)) {
    void Promise.resolve(
      chat.addToolApprovalResponse({
        approved: response.approved,
        id: response.id,
        reason: response.reason,
      }),
    ).catch((error: unknown) => {
      console.debug("[tool approval ai-sdk response]", error);
    });
  }

  apiClient
    .toolApprovalResponse({
      approved: response.approved,
      id: response.id,
      reason: response.reason ?? null,
      scope: response.scope ?? "once",
    })
    .catch((error) => {
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
): boolean => {
  const session = getChatSession(chatId) as InternalChatSession;
  const { chat } = session;

  if (isChatProcessing(chat)) {
    throw new Error(chatT("alreadyStreaming"));
  }

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
    storedMessages.length === 0 && config.title === "New chat";
  const gitGenerationModelSelection =
    getDefaultGitGenerationModelSelection(settings);

  const submittedAt = new Date().toISOString();
  session.pendingAssistantMetadata = {
    createdAt: submittedAt,
    ...selectionMetadata,
    startedAt: submittedAt,
  };

  useIdeStore.getState().setChatStreaming(chatId, true);
  if (shouldGenerateTitle) {
    generateChatTitle({
      chatId,
      fallbackModel: activeModel,
      projectPath: submittedProjectPath,
      promptText:
        prompt.text ||
        `Referenced project paths:\n${formatProjectReferencesForPrompt(projectReferences)}`,
      provider: activeProvider,
      titleBeforeGeneration: config.title,
    });
  }

  const finishStreaming = () => {
    useIdeStore.getState().setChatStreaming(chatId, false);
    flushProjectPanelRefresh(submittedProject.id);
    void warmProjectCommitMessage({
      model: gitGenerationModelSelection.model,
      modelSpeed: gitGenerationModelSelection.modelSpeed,
      projectPath: submittedProjectPath,
      provider: gitGenerationModelSelection.provider,
      reasoningEffort: gitGenerationModelSelection.reasoningEffort,
      refreshToken:
        useIdeStore.getState().projectGitRefreshKeys[submittedProject.id] ?? 0,
    });
    scheduleEviction(session);
  };

  try {
    const sendPromise = chat.sendMessage(
      {
        files: prompt.files,
        metadata: {
          createdAt: new Date().toISOString(),
          ...selectionMetadata,
          projectReferences,
          ...(prompt.skills && prompt.skills.length > 0
            ? { skillMentions: prompt.skills }
            : {}),
        },
        text: prompt.text,
      },
      {
        body: {
          ...selectionMetadata,

          chatId,
          checkpointsEnabled: settings.changeCheckpoints,
          mcpServers: getProviderCapabilities(activeProvider).mcp
            ? resolveEffectiveMcpServers(settings)
            : [],
          permissionMode: config.permissionMode,
          projectId: submittedProject.id,
          projectPath: submittedProjectPath,
          projectReferences,
          provider: activeProvider,
          remoteConversationId: config.remoteConversationId,
          remoteConversationModel: config.remoteConversationModel,
          remoteConversationModelSpeed: config.remoteConversationModelSpeed,
          remoteConversationProjectPath: config.remoteConversationProjectPath,
        },
      },
    );
    void sendPromise.finally(finishStreaming).catch(() => {});
    return true;
  } catch (error) {
    useActivityStore
      .getState()
      .finish(chatId, "failed", error instanceof Error ? error.message : "");
    finishStreaming();
    throw error;
  }
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
    await useIdeStore.getState().loadMessagesForChat(chatId);

    const state = useIdeStore.getState();
    if (!state.pendingChatSubmitByChatId[chatId]) {
      return;
    }

    // Still busy: tried again when the chat's streaming flag clears.
    if (isChatProcessing(getChatSession(chatId).chat)) {
      return;
    }

    const submission = state.takePendingChatSubmit(chatId);
    if (!submission || isEmptySubmission(submission)) {
      return;
    }

    try {
      const serialized = await serializeQueuedSubmission(chatId, submission);
      const submitted = submitChatPrompt(chatId, {
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
  if (merged !== session.chat.messages) {
    session.chat.messages = merged;
  }
  if (merged === storeMessages) {
    // Nothing newer than what the store already holds.
    session.lastFlushedMessages = session.chat.messages;
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
          resumeHostTurn(session);
        }
      }
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
