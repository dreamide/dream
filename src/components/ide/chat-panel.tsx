import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
} from "@/lib/models";
import dreamSvg from "@/assets/dream.svg";
import type {
  ChatConfig,
  ChatTitleResponse,
  ProjectConfig,
  ProjectReference,
} from "@/types/ide";
import { getChipToolKind } from "./assistant-message-tools";
import {
  addMetadataToMessage,
  CHAT_CONTENT_BOTTOM_PADDING_PX,
  CHAT_STREAM_UPDATE_THROTTLE_MS,
  type ChatMessageMetadata,
  ConversationScrollMemory,
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
import { VirtualizedChatMessages } from "./chat/virtualized-chat-messages";
import {
  getCommitChanges,
  warmProjectCommitMessageForStatus,
} from "./git-commit-message-cache";
import { useIdeStore } from "./ide-store";
import {
  normalizeReasoningEffort,
  REASONING_EFFORT_OPTIONS,
} from "./ide-types";

const EMPTY_MESSAGES: UIMessage[] = [];

const formatProjectReferencesForPrompt = (references: ProjectReference[]) =>
  references
    .map((reference) => `- ${reference.kind}: ${reference.path}`)
    .join("\n");

export const ChatPanel = ({
  isActive,
  project,
  chat,
}: {
  isActive: boolean;
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
  const providerModels = useIdeStore((s) => s.providerModels);
  const claudePermissionMode = useIdeStore((s) => s.claudePermissionMode);
  const setClaudePermissionMode = useIdeStore((s) => s.setClaudePermissionMode);
  const codexPermissionMode = useIdeStore((s) => s.codexPermissionMode);
  const setCodexPermissionMode = useIdeStore((s) => s.setCodexPermissionMode);
  const setMessagesForChat = useIdeStore((s) => s.setMessagesForChat);
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

      if (pendingMetadata) {
        setMessages((currentMessages) =>
          addMetadataToMessage(currentMessages, message.id, {
            ...pendingMetadata,
            createdAt:
              typeof metadata?.createdAt === "string" && metadata.createdAt
                ? metadata.createdAt
                : new Date().toISOString(),
          }),
        );
      }

      const remoteConversationId = metadata?.remoteConversationId?.trim();

      if (!remoteConversationId) {
        return;
      }

      updateChat(chat.id, (current) => ({
        ...current,
        remoteConversationId,
        remoteConversationModel:
          metadata?.remoteConversationModel ?? current.model,
        remoteConversationProjectPath:
          metadata?.remoteConversationProjectPath ?? project.path,
      }));
    },
    transport,
  });

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

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      if (isProcessing) {
        throw new Error("Chat response is already streaming.");
      }

      setLocalError(null);
      clearError();

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
      pendingAssistantMetadataRef.current = {
        model: activeModel,
        modelLabel: activeOption?.label ?? activeModel,
        reasoningEffort: selectedReasoningEffort,
        reasoningLabel: selectedReasoningLabel,
      };
      resetPromptHistory();

      setPromptText("");
      useIdeStore.getState().setChatStreaming(submittedChatId, true);
      if (shouldGenerateTitle) {
        void fetch("/api/chat-title", {
          body: JSON.stringify({
            fallbackModel: activeModel,
            projectPath: project.path,
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
          });
      }
      try {
        const sendPromise = sendMessage(
          {
            files: prompt.files,
            metadata: {
              createdAt: new Date().toISOString(),
              model: activeModel,
              modelLabel: activeOption?.label ?? activeModel,
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
              projectPath: project.path,
              provider: activeProvider,
              reasoningEffort: selectedReasoningEffort,
              reasoningLabel: selectedReasoningLabel,
              remoteConversationId: chat.remoteConversationId,
              remoteConversationModel: chat.remoteConversationModel,
              remoteConversationProjectPath: chat.remoteConversationProjectPath,
              chatId: chat.id,
            },
          },
        );
        scrollConversationToBottom();
        await sendPromise;
      } finally {
        useIdeStore.getState().setChatStreaming(submittedChatId, false);
        const nextGitRefreshKey =
          (useIdeStore.getState().projectGitRefreshKeys[project.id] ?? 0) + 1;
        pendingCommitMessageWarmRefreshTokensRef.current.add(nextGitRefreshKey);
        bumpProjectGitRefreshKey(project.id);
        bumpProjectFilesRefreshKey(project.id);
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
      providerModels,
      project.id,
      project.path,
      resetPromptHistory,
      selectedProvider,
      selectedReasoningEffort,
      selectedReasoningLabel,
      sendMessage,
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

  const showChatHeader = messages.length > 0;
  const canShowChatMenu = !isDraftChat || messages.length > 0;

  return (
    <>
      <div id={panelDomId} className="flex h-full min-h-0 flex-col">
        {showChatHeader ? (
          <ChatPanelHeader
            canShowChatMenu={canShowChatMenu}
            chatMenuOpen={chatMenuOpen}
            onChatMenuOpenChange={setChatMenuOpen}
            onDeleteChat={() => deleteChat(chat.id)}
            onEditChat={handleEditChat}
            title={chat.title}
          />
        ) : null}

        <Conversation
          contextRef={conversationContextRef}
          id={conversationDomId}
          className="min-h-0 flex-1"
          initial={false}
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
              <VirtualizedChatMessages
                addToolApprovalResponse={addToolApprovalResponse}
                expandToolCalls={settings.expandToolCalls}
                groupToolCalls={settings.groupToolCalls}
                isStreaming={isStreaming}
                messages={messages}
                projectPath={project.path}
                showReasoningSummaries={settings.showReasoningSummaries}
              />
            )}
          </ConversationContent>
          <ConversationScrollMemory isActive={isActive} />
          <ConversationScrollButton />
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
          allModelOptions={allModelOptions}
          chatProvider={chat.provider}
          claudePermissionMode={claudePermissionMode}
          codexPermissionMode={codexPermissionMode}
          contextWindow={contextWindow}
          estimatedUsedTokens={estimatedUsedTokens}
          isProcessing={isProcessing}
          isProviderInstalled={isProviderInstalled}
          modelId={modelId}
          onClaudePermissionModeChange={setClaudePermissionMode}
          onCodexPermissionModeChange={setCodexPermissionMode}
          onModelChange={(nextOption) => {
            updateChat(chat.id, (current) => ({
              ...current,
              model: nextOption.id,
              provider: nextOption.provider,
              remoteConversationId: null,
              remoteConversationModel: null,
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
          selectedModel={selectedModel}
          selectedModelLabel={selectedModelLabel}
          selectedModelValue={selectedModelValue}
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
