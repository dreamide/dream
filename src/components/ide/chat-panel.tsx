import { useChat } from "@ai-sdk/react";
import type { LanguageModelUsage, UIMessage } from "ai";
import { useTranslations } from "next-intl";
import {
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import dreamSvg from "@/assets/dream.svg";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { getUsageReasoningTokens } from "@/lib/ai-usage";
import { getModelContextWindow } from "@/lib/models";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import {
  CHAT_CONTENT_BOTTOM_PADDING_PX,
  CHAT_STREAM_UPDATE_THROTTLE_MS,
  ChatMessage,
  type ChatMessageMetadata,
  type EditTarget,
  type ToolApprovalResponder,
} from "./chat";
import { ChatComposer } from "./chat/chat-composer";
import { ChatErrorBanner } from "./chat/chat-error-banner";
import {
  getChatModelOptions,
  resolveChatModelSelection,
} from "./chat/chat-model-selection";
import { ChatPanelHeader } from "./chat/chat-panel-header";
import {
  useChatAutoScroll,
  useChatSession,
  usePromptHistoryNavigation,
} from "./chat/chat-panel-hooks";
import {
  dismissChatError,
  respondToToolApproval,
  setChatError,
  submitChatPrompt,
  takeChatDraftRestore,
  useChatRuntimeStore,
} from "./chat/chat-runtime";
import type { ContinueChatPopoverContext } from "./chat/continue-chat-popover";
import { EditChatDialog } from "./chat/edit-chat-dialog";
import { estimateMessages } from "./chat/message-token-estimate";
import { getLatestChatTodoSummary } from "./chat/todo-list";
import {
  CHAT_TRANSCRIPT_WINDOW_SIZE,
  getTranscriptWindow,
} from "./chat/transcript-window";
import { useIdeStore } from "./ide-store";
import { MODEL_SPEED_OPTIONS, REASONING_EFFORT_OPTIONS } from "./ide-types";
import { ProjectBranchFooter } from "./project-status-bar";
import { RunTaskSubmenu } from "./tasks/run-task-submenu";
import { WORKSPACE_VIEWPORT_BACKGROUND } from "./workspace";

const CHAT_PANEL_BACKGROUND_STYLE: CSSProperties = {
  backgroundColor: WORKSPACE_VIEWPORT_BACKGROUND,
};
const CHAT_HISTORY_MESSAGE_STYLE: CSSProperties = {
  containIntrinsicSize: "auto 180px",
  contentVisibility: "auto",
};
const CHAT_CONVERSATION_FADE_HEIGHT_PX = 24;
const CHAT_CONVERSATION_FADE_HORIZONTAL_INSET =
  "max(0px, calc((100% - 700px) / 2))";
const CHAT_CONVERSATION_FADE_RIGHT_INSET =
  "max(12px, calc((100% - 700px) / 2))";
const CLAUDE_SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const CHAT_CONVERSATION_TOP_FADE_STYLE: CSSProperties = {
  background: `linear-gradient(to bottom, ${WORKSPACE_VIEWPORT_BACKGROUND} 0%, transparent 100%)`,
  height: CHAT_CONVERSATION_FADE_HEIGHT_PX,
  left: CHAT_CONVERSATION_FADE_HORIZONTAL_INSET,
  right: CHAT_CONVERSATION_FADE_RIGHT_INSET,
};
const CHAT_CONVERSATION_BOTTOM_FADE_STYLE: CSSProperties = {
  background: `linear-gradient(to top, ${WORKSPACE_VIEWPORT_BACKGROUND} 0%, transparent 100%)`,
  height: CHAT_CONVERSATION_FADE_HEIGHT_PX,
  left: CHAT_CONVERSATION_FADE_HORIZONTAL_INSET,
  right: CHAT_CONVERSATION_FADE_RIGHT_INSET,
};

const getUsageContextTokens = (usage: LanguageModelUsage) => {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return undefined;
  }

  return (
    (usage.inputTokens ?? 0) +
    (usage.outputTokens ?? 0) +
    getUsageReasoningTokens(usage)
  );
};

// A turn's exact input usage already includes the previous chat history.
// Summing exact usage across turns double-counts older messages, so the latest
// assistant usage is the best exact snapshot of current context pressure.
const getLatestAssistantMetadata = (messages: UIMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") {
      continue;
    }

    const metadata = message.metadata as ChatMessageMetadata | undefined;
    if (metadata) {
      return metadata;
    }
  }

  return undefined;
};

export const ChatPanel = ({
  canCloseChat = false,
  isActive,
  isProjectActive = isActive,
  readOnly = false,
  onActivateChat,
  onCloseChat,
  onHeaderPointerDown,
  project,
  chat,
}: {
  canCloseChat?: boolean;
  isActive: boolean;
  isProjectActive?: boolean;
  readOnly?: boolean;
  onActivateChat?: () => void;
  onCloseChat?: () => void;
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  project: ProjectConfig;
  chat: ChatConfig;
}) => {
  const chatT = useTranslations("chat");
  const commonT = useTranslations("common");
  const modelT = useTranslations("models");
  const workspaceT = useTranslations("workspace");
  const panelDomId = `chat-panel-${chat.id}`;
  const conversationDomId = `chat-conversation-${chat.id}`;
  const conversationContentDomId = `chat-conversation-content-${chat.id}`;
  const promptDomId = `chat-prompt-${chat.id}`;
  const promptInputDomId = `chat-prompt-input-${chat.id}`;
  const settings = useIdeStore((s) => s.settings);
  const messagesLoaded = useIdeStore((s) =>
    Object.hasOwn(s.messagesByChatId, chat.id),
  );
  const loadMessagesForChat = useIdeStore((s) => s.loadMessagesForChat);
  const isDraftChat = useIdeStore(
    (s) => s.draftChatIdByProject[project.id] === chat.id,
  );
  const isTitleGenerating = useIdeStore(
    (s) => !!s.titleGeneratingChatIds[chat.id],
  );
  const providerModels = useIdeStore((s) => s.providerModels);
  const updateChat = useIdeStore((s) => s.updateChat);
  const deleteChat = useIdeStore((s) => s.deleteChat);
  const addProjectTerminal = useIdeStore((s) => s.addProjectTerminal);
  const localError = useChatRuntimeStore(
    (s) => s.errorByChatId[chat.id] ?? null,
  );
  const draftRestore = useChatRuntimeStore(
    (s) => s.draftRestoreByChatId[chat.id],
  );
  const setLocalError = useCallback(
    (message: string | null) => setChatError(chat.id, message),
    [chat.id],
  );
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[project.id] ?? 0,
  );
  const { branch: currentGitBranch, isRepo } = useProjectGitStatus(
    project.path,
    gitRefreshKey,
    {
      detail: "summary",
    },
  );
  const allModelOptions = useMemo(
    () => getChatModelOptions(settings, providerModels),
    [providerModels, settings],
  );
  const {
    availableModelSpeedTiers,
    availableReasoningEfforts,
    selectedModel,
    selectedModelOption,
    selectedModelSpeed,
    selectedProvider,
    selectedReasoningEffort,
  } = useMemo(
    () => resolveChatModelSelection(chat, allModelOptions),
    [allModelOptions, chat],
  );
  const isProviderInstalled =
    providerModels[selectedProvider]?.installed ?? false;
  const [promptText, setPromptText] = useState("");
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editValue, setEditValue] = useState("");
  const [transcriptWindowSize, setTranscriptWindowSize] = useState(
    CHAT_TRANSCRIPT_WINDOW_SIZE,
  );
  const prependScrollSnapshotRef = useRef<{
    element: HTMLElement;
    scrollHeight: number;
    scrollTop: number;
  } | null>(null);
  const previousMessageCountRef = useRef(0);
  const restoredTranscriptWindowSizeRef = useRef(CHAT_TRANSCRIPT_WINDOW_SIZE);

  useEffect(() => {
    if (!messagesLoaded) {
      void loadMessagesForChat(chat.id).catch(() => {
        setLocalError(chatT("unexpectedError"));
      });
    }
  }, [chat.id, chatT, loadMessagesForChat, messagesLoaded, setLocalError]);

  // A queued message that could not be sent comes back to the draft.
  useEffect(() => {
    if (draftRestore === undefined) {
      return;
    }
    const text = takeChatDraftRestore(chat.id);
    if (text) {
      setPromptText((current) => [current, text].filter(Boolean).join("\n\n"));
    }
  }, [chat.id, draftRestore]);

  const sessionChat = useChatSession({ chatId: chat.id, isActive });
  const { messages, status, stop } = useChat({
    chat: sessionChat,
    experimental_throttle: CHAT_STREAM_UPDATE_THROTTLE_MS,
  });

  const addToolApprovalResponse = useCallback<ToolApprovalResponder>(
    (response) => respondToToolApproval(chat.id, response),
    [chat.id],
  );

  const selectedModelLabel = selectedModelOption?.label ?? selectedModel;
  const selectedModelValue = selectedModelOption?.id;
  const speedOptions = MODEL_SPEED_OPTIONS.filter((option) =>
    availableModelSpeedTiers.includes(option.value),
  );
  const selectedModelSpeedLabel = modelT(selectedModelSpeed);
  const reasoningEffortOptions = REASONING_EFFORT_OPTIONS.filter((option) =>
    availableReasoningEfforts.includes(option.value),
  );
  const selectedReasoningEffortForControl = selectedReasoningEffort ?? "medium";
  const selectedReasoningLabel =
    selectedReasoningEffort === null
      ? modelT("reasoning")
      : modelT(selectedReasoningEffort);

  const latestAssistantMetadata = useMemo(
    () => getLatestAssistantMetadata(messages),
    [messages],
  );
  const latestAssistantContextMetadata =
    latestAssistantMetadata?.model === selectedModel
      ? latestAssistantMetadata
      : undefined;
  const contextWindow =
    latestAssistantContextMetadata?.contextWindow ??
    selectedModelOption?.contextWindow ??
    getModelContextWindow(selectedModel);
  const contextUsage = latestAssistantContextMetadata?.usage;
  const fallbackEstimatedTokens = useMemo(
    () => (contextUsage ? 0 : estimateMessages(messages)),
    [contextUsage, messages],
  );
  const contextUsedTokens =
    (contextUsage ? getUsageContextTokens(contextUsage) : undefined) ??
    fallbackEstimatedTokens;
  const todoSummary = useMemo(
    () => getLatestChatTodoSummary(messages),
    [messages],
  );

  const modelId =
    selectedProvider === "anthropic"
      ? `anthropic:${selectedModel}`
      : selectedProvider === "opencode"
        ? `opencode:${selectedModel}`
        : selectedProvider === "cursor"
          ? `cursor:${selectedModel}`
          : `openai:${selectedModel}`;

  const isStreaming = status === "streaming";
  const isProcessing = status === "submitted" || status === "streaming";
  const claudeSessionId = chat.remoteConversationId?.trim() ?? "";
  const claudeSessionProjectPath =
    chat.remoteConversationProjectPath?.trim() ?? "";
  const canContinueInTerminal =
    chat.provider === "anthropic" &&
    CLAUDE_SESSION_ID_PATTERN.test(claudeSessionId) &&
    Boolean(claudeSessionProjectPath);
  const handleContinueInTerminal = useCallback(() => {
    if (!canContinueInTerminal || isProcessing) {
      return;
    }

    setLocalError(null);
    void addProjectTerminal(project.id, {
      command: `claude --resume ${claudeSessionId}`,
      cwd: claudeSessionProjectPath,
      name: "Claude",
      strictCwd: true,
    }).catch((error) => {
      console.error("Failed to continue Claude session in terminal:", error);
      setLocalError(chatT("unableToContinueInTerminal"));
    });
  }, [
    addProjectTerminal,
    canContinueInTerminal,
    chatT,
    claudeSessionId,
    claudeSessionProjectPath,
    isProcessing,
    project.id,
    setLocalError,
  ]);
  const handleBranchError = useCallback(
    (message: string) => setLocalError(message),
    [setLocalError],
  );
  const continueChat = useMemo<ContinueChatPopoverContext>(
    () => ({
      chat,
      currentBranch: currentGitBranch,
      isProcessing,
      isRepo,
      onError: handleBranchError,
    }),
    [chat, currentGitBranch, handleBranchError, isProcessing, isRepo],
  );

  const { conversationContextRef, scrollConversationToBottom } =
    useChatAutoScroll({
      isActive,
      isProcessing,
      messages,
    });
  const transcriptWindow = useMemo(
    () => getTranscriptWindow(messages, transcriptWindowSize),
    [messages, transcriptWindowSize],
  );

  useEffect(() => {
    if (messages.length < previousMessageCountRef.current) {
      setTranscriptWindowSize(CHAT_TRANSCRIPT_WINDOW_SIZE);
    }
    previousMessageCountRef.current = messages.length;
  }, [messages.length]);
  const handleLoadEarlierMessages = useCallback(() => {
    const element = conversationContextRef.current?.scrollRef.current;
    prependScrollSnapshotRef.current = element
      ? {
          element,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
        }
      : null;
    setTranscriptWindowSize((currentSize) =>
      Math.min(messages.length, currentSize + CHAT_TRANSCRIPT_WINDOW_SIZE),
    );
  }, [conversationContextRef, messages.length]);

  useLayoutEffect(() => {
    if (restoredTranscriptWindowSizeRef.current === transcriptWindowSize) {
      return;
    }
    restoredTranscriptWindowSizeRef.current = transcriptWindowSize;

    const snapshot = prependScrollSnapshotRef.current;
    if (!snapshot) {
      return;
    }

    prependScrollSnapshotRef.current = null;
    snapshot.element.scrollTop =
      snapshot.scrollTop +
      Math.max(0, snapshot.element.scrollHeight - snapshot.scrollHeight);
  }, [transcriptWindowSize]);
  const { handlePromptKeyDown, resetPromptHistory } =
    usePromptHistoryNavigation({
      messages,
      promptText,
      setPromptText,
    });
  const handleActivateChat = useCallback(() => {
    if (!isActive) {
      onActivateChat?.();
    }
  }, [isActive, onActivateChat]);

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      if (readOnly) return;
      handleActivateChat();

      // The runtime validates and sends; this panel only owns the draft.
      if (!submitChatPrompt(chat.id, prompt)) {
        return;
      }

      resetPromptHistory();
      setPromptText("");
      scrollConversationToBottom();
    },
    [
      chat.id,
      handleActivateChat,
      readOnly,
      resetPromptHistory,
      scrollConversationToBottom,
    ],
  );

  const closeEditDialog = useCallback(() => {
    setEditTarget(null);
    setEditValue("");
  }, []);

  const handleEditChat = useCallback(() => {
    setEditTarget({ id: chat.id, name: chat.title });
    setEditValue(chat.title);
  }, [chat.id, chat.title]);

  const handleEditSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const nextName = editValue.trim();
      if (!editTarget || !nextName) {
        return;
      }

      updateChat(editTarget.id, (current) => ({
        ...current,
        title: nextName,
      }));
      closeEditDialog();
    },
    [closeEditDialog, editTarget, editValue, updateChat],
  );

  const showChatHeader = messages.length > 0 || canCloseChat;
  const canShowChatMenu = !isDraftChat || messages.length > 0;

  return (
    <>
      <div
        id={panelDomId}
        className="flex h-full min-h-0 flex-col"
        onFocusCapture={handleActivateChat}
        onPointerDownCapture={handleActivateChat}
        style={CHAT_PANEL_BACKGROUND_STYLE}
      >
        {showChatHeader ? (
          <ChatPanelHeader
            canCloseChat={canCloseChat}
            canShowChatMenu={canShowChatMenu}
            chatMenuOpen={chatMenuOpen}
            continueInTerminalDisabled={isProcessing}
            isTitleGenerating={isTitleGenerating}
            onCloseChat={onCloseChat}
            onChatMenuOpenChange={setChatMenuOpen}
            onDeleteChat={() => deleteChat(chat.id)}
            onEditChat={handleEditChat}
            onContinueInTerminal={
              canContinueInTerminal ? handleContinueInTerminal : undefined
            }
            onHeaderPointerDown={onHeaderPointerDown}
            onRenameChat={(title) =>
              updateChat(chat.id, (current) => ({ ...current, title }))
            }
            title={chat.title}
          />
        ) : null}

        <Conversation
          contextRef={conversationContextRef}
          id={conversationDomId}
          className="min-h-0 flex-1"
        >
          <ConversationContent
            id={conversationContentDomId}
            className={
              messages.length === 0
                ? "mx-auto flex min-h-full w-full max-w-[700px] flex-col px-0 pt-3"
                : "relative mx-auto block w-full max-w-[700px] px-0 pt-3"
            }
            style={{ paddingBottom: CHAT_CONTENT_BOTTOM_PADDING_PX }}
          >
            {!messagesLoaded ? (
              <div className="flex flex-1 items-center justify-center">
                <Spinner className="size-5 text-muted-foreground" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
                <img
                  alt=""
                  className="size-16"
                  draggable={false}
                  src={dreamSvg}
                />
                <p className="font-medium text-lg">{chatT("buildAnything")}</p>
              </div>
            ) : (
              <>
                {transcriptWindow.hiddenMessageCount > 0 ? (
                  <div className="flex w-full justify-center pb-4">
                    <Button
                      onClick={handleLoadEarlierMessages}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {commonT("open")} {workspaceT("chatHistory")} (
                      {transcriptWindow.hiddenMessageCount})
                    </Button>
                  </div>
                ) : null}
                {transcriptWindow.messages.map((message, index) => {
                  const messageIndex = transcriptWindow.startIndex + index;
                  const isLastMessage = messageIndex === messages.length - 1;

                  return (
                    <div
                      className="w-full pb-4"
                      key={message.id}
                      style={
                        isLastMessage ? undefined : CHAT_HISTORY_MESSAGE_STYLE
                      }
                    >
                      <ChatMessage
                        addToolApprovalResponse={addToolApprovalResponse}
                        continueChat={continueChat}
                        expandToolCalls={settings.expandToolCalls}
                        groupToolCalls={settings.groupToolCalls}
                        isLastMessage={isLastMessage}
                        isStreaming={isStreaming}
                        message={message}
                        projectPath={project.path}
                        showReasoningSummaries={settings.showReasoningSummaries}
                      />
                    </div>
                  );
                })}
              </>
            )}
          </ConversationContent>
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 z-10"
            style={CHAT_CONVERSATION_TOP_FADE_STYLE}
          />
          {isStreaming ? null : (
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-0 z-10"
              style={CHAT_CONVERSATION_BOTTOM_FADE_STYLE}
            />
          )}
          <ConversationScrollButton className="z-20" />
        </Conversation>

        {localError ? (
          <ChatErrorBanner
            error={localError}
            onDismiss={() => dismissChatError(chat.id)}
          />
        ) : null}

        {readOnly ? null : (
          <ChatComposer
            allModelOptions={allModelOptions}
            chatProvider={chat.provider}
            contextWindow={contextWindow}
            contextUsage={contextUsage}
            contextUsedTokens={contextUsedTokens}
            isActive={isProjectActive && messagesLoaded}
            isProcessing={isProcessing}
            isProviderInstalled={isProviderInstalled}
            modelId={modelId}
            onModelChange={(nextOption) => {
              updateChat(chat.id, (current) => ({
                ...current,
                model: nextOption.id,
                modelSpeed: "standard",
                provider: nextOption.provider,
                reasoningEffort: null,
                remoteConversationId: null,
                remoteConversationModel: null,
                remoteConversationModelSpeed: null,
                remoteConversationProjectPath: null,
              }));
            }}
            onModelSpeedChange={(modelSpeed) => {
              updateChat(chat.id, (current) => ({
                ...current,
                modelSpeed,
                remoteConversationId: null,
                remoteConversationModel: null,
                remoteConversationModelSpeed: null,
                remoteConversationProjectPath: null,
              }));
            }}
            onPermissionModeChange={(permissionMode) => {
              updateChat(chat.id, (current) => ({
                ...current,
                permissionMode,
              }));
            }}
            onPromptKeyDown={handlePromptKeyDown}
            onPromptTextChange={setPromptText}
            onReasoningEffortChange={(reasoningEffort) => {
              updateChat(chat.id, (current) => ({
                ...current,
                reasoningEffort:
                  reasoningEffort === "medium" ? null : reasoningEffort,
              }));
            }}
            onSparklesPaletteChange={(sparklesPalette) => {
              updateChat(chat.id, (current) => ({
                ...current,
                sparklesPalette,
              }));
            }}
            onStop={stop}
            onSubmit={handleSubmit}
            promptDomId={promptDomId}
            promptInputDomId={promptInputDomId}
            promptText={promptText}
            permissionMode={chat.permissionMode}
            projectPath={project.path}
            reasoningEffortOptions={reasoningEffortOptions}
            speedOptions={speedOptions}
            selectedModel={selectedModel}
            selectedModelLabel={selectedModelLabel}
            selectedModelValue={selectedModelValue}
            selectedModelSpeed={selectedModelSpeed}
            selectedModelSpeedLabel={selectedModelSpeedLabel}
            selectedProvider={selectedProvider}
            selectedReasoningEffort={selectedReasoningEffortForControl}
            selectedReasoningLabel={selectedReasoningLabel}
            sparklesPalette={chat.sparklesPalette}
            status={status}
            todoSummary={todoSummary}
            actionMenuItems={
              <RunTaskSubmenu
                branch={currentGitBranch}
                chatId={chat.id}
                projectId={project.id}
              />
            }
          />
        )}

        <ProjectBranchFooter project={project} />
      </div>

      <EditChatDialog
        editValue={editValue}
        onClose={closeEditDialog}
        onEditValueChange={setEditValue}
        onSubmit={handleEditSubmit}
        open={editTarget !== null}
      />
    </>
  );
};
