import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  type CSSProperties,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
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
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import {
  getConnectedProviders,
  getModelOptionsForProvider,
} from "@/lib/ide-defaults";
import {
  estimateTokenCount,
  getModelContextWindow,
  getModelReasoningEfforts,
  getModelSpeedTiers,
} from "@/lib/models";
import type {
  ChatConfig,
  ChatTitleResponse,
  ProjectConfig,
  ProjectReference,
} from "@/types/ide";
import { getChipToolKind } from "./assistant-message-tools";
import {
  CHAT_CONTENT_BOTTOM_PADDING_PX,
  CHAT_STREAM_UPDATE_THROTTLE_MS,
  ChatMessage,
  type ChatMessageMetadata,
  type EditTarget,
  PROVIDER_LABELS,
  type ToolApprovalResponder,
} from "./chat";
import { ChatComposer, type ChatPanelModelOption } from "./chat/chat-composer";
import { ChatErrorBanner } from "./chat/chat-error-banner";
import { ChatPanelHeader } from "./chat/chat-panel-header";
import {
  useChatAutoScroll,
  useChatMessageSync,
  usePromptHistoryNavigation,
} from "./chat/chat-panel-hooks";
import { EditChatDialog } from "./chat/edit-chat-dialog";
import { mergeChatMessageHistories } from "./chat-message-history";
import {
  getCommitChanges,
  warmProjectCommitMessageForStatus,
} from "./git-commit-message-cache";
import { useIdeStore } from "./ide-store";
import {
  getPermissionModesForAgentMode,
  MODEL_SPEED_OPTIONS,
  normalizeModelSpeed,
  normalizeReasoningEffort,
  REASONING_EFFORT_OPTIONS,
} from "./ide-types";
import { WORKSPACE_VIEWPORT_BACKGROUND } from "./workspace";

const EMPTY_MESSAGES: UIMessage[] = [];
const CHAT_PANEL_BACKGROUND_STYLE: CSSProperties = {
  backgroundColor: WORKSPACE_VIEWPORT_BACKGROUND,
};
const CHAT_CONVERSATION_FADE_HEIGHT_PX = 24;
const CHAT_CONVERSATION_TOP_FADE_STYLE: CSSProperties = {
  background: `linear-gradient(to bottom, ${WORKSPACE_VIEWPORT_BACKGROUND} 0%, transparent 100%)`,
  height: CHAT_CONVERSATION_FADE_HEIGHT_PX,
};
const CHAT_CONVERSATION_BOTTOM_FADE_STYLE: CSSProperties = {
  background: `linear-gradient(to top, ${WORKSPACE_VIEWPORT_BACKGROUND} 0%, transparent 100%)`,
  height: CHAT_CONVERSATION_FADE_HEIGHT_PX,
};

const formatProjectReferencesForPrompt = (references: ProjectReference[]) =>
  references
    .map((reference) => `- ${reference.kind}: ${reference.path}`)
    .join("\n");

export const ChatPanel = ({
  canCloseChat = false,
  isActive,
  isProjectActive = isActive,
  onActivateChat,
  onCloseChat,
  onHeaderPointerDown,
  project,
  chat,
}: {
  canCloseChat?: boolean;
  isActive: boolean;
  isProjectActive?: boolean;
  onActivateChat?: () => void;
  onCloseChat?: () => void;
  onHeaderPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  project: ProjectConfig;
  chat: ChatConfig;
}) => {
  const panelDomId = `chat-panel-${chat.id}`;
  const conversationDomId = `chat-conversation-${chat.id}`;
  const conversationContentDomId = `chat-conversation-content-${chat.id}`;
  const promptDomId = `chat-prompt-${chat.id}`;
  const promptInputDomId = `chat-prompt-input-${chat.id}`;
  const settings = useIdeStore((s) => s.settings);
  const chatMessages = useIdeStore(
    (s) => s.messagesByChatId[chat.id] ?? EMPTY_MESSAGES,
  );
  const isDraftChat = useIdeStore(
    (s) => s.draftChatIdByProject[project.id] === chat.id,
  );
  const isTitleGenerating = useIdeStore(
    (s) => !!s.titleGeneratingChatIds[chat.id],
  );
  const providerModels = useIdeStore((s) => s.providerModels);
  const setMessagesForChat = useIdeStore((s) => s.setMessagesForChat);
  const setChatTitleGenerating = useIdeStore((s) => s.setChatTitleGenerating);
  const updateChat = useIdeStore((s) => s.updateChat);
  const deleteChat = useIdeStore((s) => s.deleteChat);
  const bumpProjectGitRefreshKey = useIdeStore(
    (s) => s.bumpProjectGitRefreshKey,
  );
  const bumpProjectFilesRefreshKey = useIdeStore(
    (s) => s.bumpProjectFilesRefreshKey,
  );
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[project.id] ?? 0,
  );
  const { status: projectGitStatus } = useProjectGitStatus(
    project.path,
    gitRefreshKey,
  );
  const permissionModes = settings.autoAcceptPermissions
    ? {
        claudePermissionMode: "bypass-permissions" as const,
        codexPermissionMode: "full-access" as const,
      }
    : getPermissionModesForAgentMode(chat.agentMode);
  const { claudePermissionMode, codexPermissionMode } = permissionModes;
  const connectedProviders = getConnectedProviders(settings);
  const allModelOptions = useMemo<ChatPanelModelOption[]>(() => {
    return connectedProviders.flatMap((provider) =>
      getModelOptionsForProvider(
        provider,
        settings,
        providerModels[provider].models,
      ).map((model) => ({
        id: model.id,
        label: model.label,
        provider,
        reasoningEfforts: model.reasoningEfforts ?? [],
        speedTiers: model.speedTiers ?? [],
      })),
    );
  }, [connectedProviders, providerModels, settings]);

  const selectedModelOption =
    allModelOptions.find(
      (option) => option.provider === chat.provider && option.id === chat.model,
    ) ?? allModelOptions[0];
  const selectedProvider = selectedModelOption?.provider ?? chat.provider;
  const isProviderInstalled =
    providerModels[selectedProvider]?.installed ?? false;
  const [localError, setLocalError] = useState<string | null>(null);
  const [promptText, setPromptText] = useState("");
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editValue, setEditValue] = useState("");
  const refreshedWriteEventsRef = useRef(new Set<string>());
  const pendingCommitMessageWarmRefreshTokensRef = useRef(new Set<number>());
  const warmedCommitMessageKeysRef = useRef(new Set<string>());
  const pendingAssistantMetadataRef = useRef<ChatMessageMetadata | null>(null);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );

  const {
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
    addToolApprovalResponse: addAiSdkToolApprovalResponse,
    clearError,
  } = useChat({
    experimental_throttle: CHAT_STREAM_UPDATE_THROTTLE_MS,
    id: `chat:${chat.id}`,
    messages: chatMessages,
    onError: (error) => {
      console.error("[chat error]", error);

      // The server-side onError already enriches the message, so
      // error.message should be descriptive. Guard against edge cases
      // where only the generic class name "Error" comes through.
      const msg = error.message;
      if (msg && msg !== "Error") {
        setLocalError(msg);
        return;
      }

      // Fallback: try cause chain
      if (error.cause instanceof Error && error.cause.message) {
        setLocalError(error.cause.message);
        return;
      }

      setLocalError(
        "An unexpected error occurred. Check the developer console for details.",
      );
    },
    onFinish: ({ message }) => {
      const metadata = message.metadata as ChatMessageMetadata | undefined;
      const pendingMetadata = pendingAssistantMetadataRef.current;
      pendingAssistantMetadataRef.current = null;
      const completedAt = new Date().toISOString();
      const messageMetadata =
        (message.metadata as Record<string, unknown> | undefined) ?? {};
      const finalAssistantMessage: UIMessage = {
        ...message,
        metadata: {
          ...messageMetadata,
          ...(pendingMetadata ?? {}),
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

      const nextMessages = mergeChatMessageHistories(
        latestMessagesRef.current,
        [finalAssistantMessage],
      );
      latestMessagesRef.current = nextMessages;
      setMessages(nextMessages);
      setMessagesForChat(chat.id, nextMessages);
      useIdeStore.getState().persist();

      const remoteConversationId = metadata?.remoteConversationId?.trim();

      if (!remoteConversationId) {
        return;
      }

      updateChat(chat.id, (current) => ({
        ...current,
        remoteConversationId,
        remoteConversationModel:
          metadata?.remoteConversationModel ?? current.model,
        remoteConversationModelSpeed: normalizeModelSpeed(
          metadata?.remoteConversationModelSpeed ?? current.modelSpeed,
        ),
        remoteConversationProjectPath:
          metadata?.remoteConversationProjectPath ?? project.path,
      }));
    },
    transport,
  });
  const latestMessagesRef = useRef<UIMessage[]>(messages);

  useEffect(() => {
    latestMessagesRef.current = messages;
  }, [messages]);

  const addToolApprovalResponse = useCallback<ToolApprovalResponder>(
    (response) => {
      void Promise.resolve(
        addAiSdkToolApprovalResponse({
          approved: response.approved,
          id: response.id,
          reason: response.reason,
        }),
      ).catch((error: unknown) => {
        console.debug("[tool approval ai-sdk response]", error);
      });

      void fetch("/api/tool-approval-response", {
        body: JSON.stringify({
          approved: response.approved,
          id: response.id,
          reason: response.reason ?? null,
          scope: response.scope ?? "once",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).catch((error) => {
        console.error("[tool approval response]", error);
      });
    },
    [addAiSdkToolApprovalResponse],
  );

  useChatMessageSync({
    chatId: chat.id,
    chatMessages,
    messages,
    setMessages,
    setMessagesForChat,
  });

  // Refresh project panels when completed write tools appear.
  useEffect(() => {
    let shouldRefreshProjectPanels = false;

    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }

      for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
        const part = message.parts[partIndex];
        if (getChipToolKind(part) !== "write") {
          continue;
        }

        const partRecord = part as Record<string, unknown>;
        if (partRecord.state !== "output-available") {
          continue;
        }

        const writeRefreshKey = `${chat.id}:${message.id}:${partIndex}`;
        if (!refreshedWriteEventsRef.current.has(writeRefreshKey)) {
          refreshedWriteEventsRef.current.add(writeRefreshKey);
          shouldRefreshProjectPanels = true;
        }
      }
    }

    if (shouldRefreshProjectPanels) {
      const nextGitRefreshKey =
        (useIdeStore.getState().projectGitRefreshKeys[project.id] ?? 0) + 1;
      pendingCommitMessageWarmRefreshTokensRef.current.add(nextGitRefreshKey);
      bumpProjectGitRefreshKey(project.id);
      bumpProjectFilesRefreshKey(project.id);
    }
  }, [
    bumpProjectFilesRefreshKey,
    bumpProjectGitRefreshKey,
    chat.id,
    messages,
    project.id,
  ]);

  useEffect(() => {
    if (!projectGitStatus) {
      return;
    }

    if (!pendingCommitMessageWarmRefreshTokensRef.current.has(gitRefreshKey)) {
      return;
    }

    pendingCommitMessageWarmRefreshTokensRef.current.delete(gitRefreshKey);
    const changes = getCommitChanges(projectGitStatus, true);
    if (changes.length === 0) {
      return;
    }

    const warmKey = JSON.stringify({
      changes: changes.map((change) => ({
        addedLines: change.addedLines,
        path: change.path,
        removedLines: change.removedLines,
        staged: change.staged,
        unstaged: change.unstaged,
      })),
      projectPath: project.path,
      provider: project.provider,
      refreshToken: gitRefreshKey,
    });
    if (warmedCommitMessageKeysRef.current.has(warmKey)) {
      return;
    }

    warmedCommitMessageKeysRef.current.add(warmKey);
    void warmProjectCommitMessageForStatus({
      projectPath: project.path,
      provider: project.provider,
      refreshToken: gitRefreshKey,
      status: projectGitStatus,
    });
  }, [gitRefreshKey, project.path, project.provider, projectGitStatus]);

  // Auto-approve Anthropic writeFile tool calls for non-interactive modes.
  useEffect(() => {
    if (
      claudePermissionMode !== "accept-edits" &&
      claudePermissionMode !== "bypass-permissions"
    ) {
      return;
    }
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (
          typeof part.type === "string" &&
          part.type === "tool-writeFile" &&
          "approval" in part &&
          part.approval &&
          typeof part.approval === "object" &&
          "id" in part.approval &&
          !("approved" in part.approval) &&
          "state" in part &&
          part.state === "approval-requested"
        ) {
          addToolApprovalResponse({
            id: part.approval.id as string,
            approved: true,
          });
        }
      }
    }
  }, [messages, claudePermissionMode, addToolApprovalResponse]);

  const selectedModel = selectedModelOption?.id ?? "";
  const selectedModelLabel = selectedModelOption?.label ?? selectedModel;
  const selectedModelValue = selectedModelOption?.id;
  const availableModelSpeedTiers = selectedModelOption?.speedTiers?.length
    ? selectedModelOption.speedTiers
    : getModelSpeedTiers(selectedProvider, selectedModel);
  const speedOptions = MODEL_SPEED_OPTIONS.filter((option) =>
    availableModelSpeedTiers.includes(option.value),
  );
  const normalizedChatModelSpeed = normalizeModelSpeed(chat.modelSpeed);
  const selectedModelSpeed =
    availableModelSpeedTiers.length === 0
      ? "standard"
      : availableModelSpeedTiers.includes(normalizedChatModelSpeed)
        ? normalizedChatModelSpeed
        : "standard";
  const selectedModelSpeedLabel =
    speedOptions.find((option) => option.value === selectedModelSpeed)?.label ??
    MODEL_SPEED_OPTIONS.find((option) => option.value === selectedModelSpeed)
      ?.label ??
    "Speed";
  const selectedModelSpeedLabelForMetadata =
    availableModelSpeedTiers.length > 0 ? selectedModelSpeedLabel : undefined;
  const availableReasoningEfforts = selectedModelOption?.reasoningEfforts
    ?.length
    ? selectedModelOption.reasoningEfforts
    : getModelReasoningEfforts(selectedProvider, selectedModel);
  const reasoningEffortOptions = REASONING_EFFORT_OPTIONS.filter((option) =>
    availableReasoningEfforts.includes(option.value),
  );
  const normalizedChatReasoningEffort = normalizeReasoningEffort(
    chat.reasoningEffort,
  );
  const selectedReasoningEffort =
    availableReasoningEfforts.length === 0
      ? normalizedChatReasoningEffort
      : availableReasoningEfforts.includes(normalizedChatReasoningEffort)
        ? normalizedChatReasoningEffort
        : availableReasoningEfforts.includes("medium")
          ? "medium"
          : availableReasoningEfforts[0];
  const selectedReasoningLabel =
    reasoningEffortOptions.find(
      (option) => option.value === selectedReasoningEffort,
    )?.label ??
    REASONING_EFFORT_OPTIONS.find(
      (option) => option.value === selectedReasoningEffort,
    )?.label ??
    "Reasoning";

  const contextWindow = getModelContextWindow(selectedModel);
  const estimatedUsedTokens = useMemo(() => {
    let total = 0;
    for (const message of messages) {
      for (const part of message.parts as Record<string, unknown>[]) {
        if (part.type === "text" && typeof part.text === "string") {
          total += estimateTokenCount(part.text);
        } else if (part.type === "reasoning" && typeof part.text === "string") {
          total += estimateTokenCount(part.text);
        } else if (
          typeof part.type === "string" &&
          (part.type.startsWith("tool-") || part.type === "dynamic-tool")
        ) {
          if (part.input) {
            total += estimateTokenCount(JSON.stringify(part.input));
          }
          if (part.output) {
            total += estimateTokenCount(JSON.stringify(part.output));
          }
        }
      }
    }
    return total;
  }, [messages]);

  const modelId =
    selectedProvider === "anthropic"
      ? `anthropic:${selectedModel}`
      : `openai:${selectedModel}`;

  const isStreaming = status === "streaming";
  const isProcessing = status === "submitted" || status === "streaming";
  const { conversationContextRef, scrollConversationToBottom } =
    useChatAutoScroll({
      isActive,
      isProcessing,
      messages,
    });
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
      if (isProcessing) {
        throw new Error("Chat response is already streaming.");
      }

      handleActivateChat();
      setLocalError(null);
      clearError();

      const state = useIdeStore.getState();
      const submittedProject = state.projects.find(
        (item) => item.id === project.id,
      );

      if (!submittedProject || state.activeProjectId !== submittedProject.id) {
        const message =
          "This chat is no longer in the active project. Switch back to this project and try again.";
        setLocalError(message);
        throw new Error(message);
      }

      const submittedProjectPath = submittedProject.path;

      const activeOption =
        allModelOptions.find(
          (option) =>
            option.provider === chat.provider && option.id === chat.model,
        ) ?? allModelOptions[0];
      const activeProvider = activeOption?.provider ?? selectedProvider;
      const activeModel = activeOption?.id ?? "";
      const activeProviderInstalled =
        providerModels[activeProvider]?.installed ?? false;

      if (!activeProviderInstalled) {
        setLocalError(
          `${PROVIDER_LABELS[activeProvider]} CLI is not available. Check Settings > Providers.`,
        );
        return;
      }

      if (!activeModel) {
        setLocalError("Enable at least one model in Settings first.");
        return;
      }

      const projectReferences = prompt.references ?? [];
      if (
        !prompt.text.trim() &&
        prompt.files.length === 0 &&
        projectReferences.length === 0
      ) {
        return;
      }

      const submittedChatId = chat.id;
      const shouldGenerateTitle =
        chatMessages.length === 0 && chat.title === "New chat";
      const titleBeforeGeneration = chat.title;
      const submittedAt = new Date().toISOString();
      pendingAssistantMetadataRef.current = {
        createdAt: submittedAt,
        model: activeModel,
        modelLabel: activeOption?.label ?? activeModel,
        modelSpeed: selectedModelSpeed,
        ...(selectedModelSpeedLabelForMetadata
          ? { modelSpeedLabel: selectedModelSpeedLabelForMetadata }
          : {}),
        reasoningEffort: selectedReasoningEffort,
        reasoningLabel: selectedReasoningLabel,
        startedAt: submittedAt,
      };
      resetPromptHistory();

      setPromptText("");
      useIdeStore.getState().setChatStreaming(submittedChatId, true);
      if (shouldGenerateTitle) {
        setChatTitleGenerating(submittedChatId, true);
        void fetch("/api/chat-title", {
          body: JSON.stringify({
            fallbackModel: activeModel,
            projectPath: submittedProjectPath,
            promptText:
              prompt.text ||
              `Referenced project paths:\n${formatProjectReferencesForPrompt(projectReferences)}`,
            provider: activeProvider,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
          .then(async (response) => {
            if (!response.ok) {
              return "";
            }
            const payload = (await response.json()) as ChatTitleResponse;
            return payload.title.trim();
          })
          .then((generatedTitle) => {
            if (!generatedTitle) {
              return;
            }
            updateChat(submittedChatId, (current) =>
              current.title === titleBeforeGeneration
                ? { ...current, title: generatedTitle }
                : current,
            );
          })
          .catch(() => {
            // Keep the default title when background title generation fails.
          })
          .finally(() => {
            useIdeStore
              .getState()
              .setChatTitleGenerating(submittedChatId, false);
          });
      }
      const finishStreaming = () => {
        useIdeStore.getState().setChatStreaming(submittedChatId, false);
        const nextGitRefreshKey =
          (useIdeStore.getState().projectGitRefreshKeys[submittedProject.id] ??
            0) + 1;
        pendingCommitMessageWarmRefreshTokensRef.current.add(nextGitRefreshKey);
        bumpProjectGitRefreshKey(submittedProject.id);
        bumpProjectFilesRefreshKey(submittedProject.id);
      };

      try {
        const sendPromise = sendMessage(
          {
            files: prompt.files,
            metadata: {
              createdAt: new Date().toISOString(),
              model: activeModel,
              modelLabel: activeOption?.label ?? activeModel,
              modelSpeed: selectedModelSpeed,
              ...(selectedModelSpeedLabelForMetadata
                ? { modelSpeedLabel: selectedModelSpeedLabelForMetadata }
                : {}),
              projectReferences,
              reasoningEffort: selectedReasoningEffort,
              reasoningLabel: selectedReasoningLabel,
            },
            text: prompt.text,
          },
          {
            body: {
              claudePermissionMode,
              codexPermissionMode,
              model: activeModel,
              modelLabel: activeOption?.label ?? activeModel,
              projectReferences,
              projectId: submittedProject.id,
              projectPath: submittedProjectPath,
              provider: activeProvider,
              modelSpeed: selectedModelSpeed,
              ...(selectedModelSpeedLabelForMetadata
                ? { modelSpeedLabel: selectedModelSpeedLabelForMetadata }
                : {}),
              reasoningEffort: selectedReasoningEffort,
              reasoningLabel: selectedReasoningLabel,
              remoteConversationId: chat.remoteConversationId,
              remoteConversationModel: chat.remoteConversationModel,
              remoteConversationModelSpeed: chat.remoteConversationModelSpeed,
              remoteConversationProjectPath: chat.remoteConversationProjectPath,
              chatId: chat.id,
            },
          },
        );
        scrollConversationToBottom();
        void sendPromise.finally(finishStreaming);
      } catch (error) {
        finishStreaming();
        throw error;
      }
    },
    [
      allModelOptions,
      bumpProjectFilesRefreshKey,
      bumpProjectGitRefreshKey,
      claudePermissionMode,
      codexPermissionMode,
      clearError,
      chatMessages,
      isProcessing,
      handleActivateChat,
      providerModels,
      project.id,
      resetPromptHistory,
      selectedProvider,
      selectedModelSpeed,
      selectedModelSpeedLabelForMetadata,
      selectedReasoningEffort,
      selectedReasoningLabel,
      sendMessage,
      setChatTitleGenerating,
      scrollConversationToBottom,
      chat,
      updateChat,
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
            isTitleGenerating={isTitleGenerating}
            onCloseChat={onCloseChat}
            onChatMenuOpenChange={setChatMenuOpen}
            onDeleteChat={() => deleteChat(chat.id)}
            onEditChat={handleEditChat}
            onHeaderPointerDown={onHeaderPointerDown}
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
            {messages.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
                <img
                  alt=""
                  className="size-16"
                  draggable={false}
                  src={dreamSvg}
                />
                <p className="font-medium text-lg">Build anything</p>
              </div>
            ) : (
              messages.map((message, index) => (
                <div className="w-full pb-4" key={message.id}>
                  <ChatMessage
                    addToolApprovalResponse={addToolApprovalResponse}
                    expandToolCalls={settings.expandToolCalls}
                    groupToolCalls={settings.groupToolCalls}
                    isLastMessage={index === messages.length - 1}
                    isStreaming={isStreaming}
                    message={message}
                    projectPath={project.path}
                    showReasoningSummaries={settings.showReasoningSummaries}
                  />
                </div>
              ))
            )}
          </ConversationContent>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 z-10"
            style={CHAT_CONVERSATION_TOP_FADE_STYLE}
          />
          {isStreaming ? null : (
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10"
              style={CHAT_CONVERSATION_BOTTOM_FADE_STYLE}
            />
          )}
          <ConversationScrollButton className="z-20" />
        </Conversation>

        {localError ? (
          <ChatErrorBanner
            error={localError}
            onDismiss={() => {
              setLocalError(null);
              clearError();
            }}
          />
        ) : null}

        <ChatComposer
          agentMode={chat.agentMode}
          allModelOptions={allModelOptions}
          chatProvider={chat.provider}
          contextWindow={contextWindow}
          estimatedUsedTokens={estimatedUsedTokens}
          isActive={isProjectActive}
          isProcessing={isProcessing}
          isProviderInstalled={isProviderInstalled}
          modelId={modelId}
          onAgentModeChange={(agentMode) => {
            updateChat(chat.id, (current) => ({
              ...current,
              agentMode,
            }));
          }}
          onModelChange={(nextOption) => {
            updateChat(chat.id, (current) => ({
              ...current,
              model: nextOption.id,
              modelSpeed: "standard",
              provider: nextOption.provider,
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
          onPromptKeyDown={handlePromptKeyDown}
          onPromptTextChange={setPromptText}
          onReasoningEffortChange={(reasoningEffort) => {
            updateChat(chat.id, (current) => ({
              ...current,
              reasoningEffort,
            }));
          }}
          onStop={stop}
          onSubmit={handleSubmit}
          promptDomId={promptDomId}
          promptInputDomId={promptInputDomId}
          promptText={promptText}
          projectId={project.id}
          projectPath={project.path}
          reasoningEffortOptions={reasoningEffortOptions}
          speedOptions={speedOptions}
          selectedModel={selectedModel}
          selectedModelLabel={selectedModelLabel}
          selectedModelValue={selectedModelValue}
          selectedModelSpeed={selectedModelSpeed}
          selectedModelSpeedLabel={selectedModelSpeedLabel}
          selectedProvider={selectedProvider}
          selectedReasoningEffort={selectedReasoningEffort}
          selectedReasoningLabel={selectedReasoningLabel}
          status={status}
        />
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
