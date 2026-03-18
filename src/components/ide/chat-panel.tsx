import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { AlertCircle, CheckCheck, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextInputUsage,
  ContextOutputUsage,
  ContextReasoningUsage,
  ContextTrigger,
} from "@/components/ai-elements/context";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { ProviderIcon } from "@/components/ai-elements/provider-icons";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  getConnectedProviders,
  getModelOptionsForProvider,
  getProviderAuthMode,
  getProviderCredential,
} from "@/lib/ide-defaults";
import {
  estimateTokenCount,
  getModelContextWindow,
  getModelReasoningEfforts,
} from "@/lib/models";
import { cn } from "@/lib/utils";
import type {
  AiProvider,
  ChatMode,
  ProjectConfig,
  ReasoningEffort,
  ThreadConfig,
} from "@/types/ide";
import {
  AssistantMessagePart,
  isChipToolPart,
  ListFilesChip,
  ReadFileChip,
  SearchInFilesChip,
  WriteFileChip,
} from "./assistant-message-part";
import { renderUserMessageText } from "./ide-state";
import { useIdeStore } from "./ide-store";
import {
  CHAT_MODE_OPTIONS,
  normalizeChatMode,
  normalizeReasoningEffort,
  REASONING_EFFORT_OPTIONS,
} from "./ide-types";

const EMPTY_MESSAGES: UIMessage[] = [];

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
};

const ConversationScrollMemory = ({
  scrollPositionsRef,
  threadId,
}: {
  scrollPositionsRef: React.MutableRefObject<Record<string, number>>;
  threadId: string;
}) => {
  const { scrollRef, scrollToBottom, stopScroll } = useStickToBottomContext();

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const saveScroll = () => {
      scrollPositionsRef.current[threadId] = element.scrollTop;
    };

    saveScroll();
    element.addEventListener("scroll", saveScroll, { passive: true });

    return () => {
      saveScroll();
      element.removeEventListener("scroll", saveScroll);
    };
  }, [scrollPositionsRef, scrollRef, threadId]);

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;

      stopScroll();
      const savedScroll = scrollPositionsRef.current[threadId];

      if (typeof savedScroll === "number") {
        element.scrollTop = savedScroll;
        return;
      }

      void scrollToBottom("instant");
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [scrollPositionsRef, scrollRef, scrollToBottom, stopScroll, threadId]);

  return null;
};

const inferThreadTitle = (promptText: string): string => {
  const collapsed = promptText.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "New thread";
  }

  return collapsed.slice(0, 60);
};

const getMessagePartKey = (
  messageId: string,
  part: Record<string, unknown>,
  index: number,
): string => {
  const partId =
    (typeof part.id === "string" && part.id) ||
    (typeof part.toolCallId === "string" && part.toolCallId) ||
    (typeof part.providerExecutedId === "string" && part.providerExecutedId);

  if (partId) {
    return `${messageId}-${part.type ?? "part"}-${partId}-${index}`;
  }

  return `${messageId}-${part.type ?? "part"}-${index}`;
};

export const ChatPanel = ({
  project,
  thread,
}: {
  project: ProjectConfig;
  thread: ThreadConfig;
}) => {
  const settings = useIdeStore((s) => s.settings);
  const threadMessages = useIdeStore(
    (s) => s.chats[thread.id] ?? EMPTY_MESSAGES,
  );
  const providerModels = useIdeStore((s) => s.providerModels);
  const autoAcceptEdits = useIdeStore((s) => s.autoAcceptEdits);
  const setAutoAcceptEdits = useIdeStore((s) => s.setAutoAcceptEdits);
  const setMessagesForThread = useIdeStore((s) => s.setMessagesForThread);
  const setSettings = useIdeStore((s) => s.setSettings);
  const updateThread = useIdeStore((s) => s.updateThread);
  const scrollPositionsRef = useRef<Record<string, number>>({});

  const connectedProviders = getConnectedProviders(settings);
  const allModelOptions = useMemo(() => {
    return connectedProviders.flatMap((provider) =>
      getModelOptionsForProvider(
        provider,
        settings,
        providerModels[provider].models,
      ).map((model) => ({
        id: model.id,
        label: model.label,
        provider,
      })),
    );
  }, [connectedProviders, providerModels, settings]);

  const groupedModelOptions = useMemo(() => {
    const groups: {
      provider: AiProvider;
      label: string;
      models: typeof allModelOptions;
    }[] = [];
    for (const provider of connectedProviders) {
      const models = allModelOptions.filter((m) => m.provider === provider);
      if (models.length > 0) {
        groups.push({ provider, label: PROVIDER_LABELS[provider], models });
      }
    }
    return groups;
  }, [connectedProviders, allModelOptions]);

  const selectedModelOption =
    allModelOptions.find(
      (option) =>
        option.provider === thread.provider && option.id === thread.model,
    ) ?? allModelOptions[0];
  const selectedProvider = selectedModelOption?.provider ?? thread.provider;
  const isProviderConnected = connectedProviders.includes(selectedProvider);
  const providerAuthMode = getProviderAuthMode(selectedProvider, settings);
  const providerCredential = getProviderCredential(selectedProvider, settings);
  const usesCodexLogin =
    selectedProvider === "openai" && providerAuthMode === "codex";
  const usesAnthropicProMax =
    selectedProvider === "anthropic" && providerAuthMode === "claudeProMax";
  const hasProviderCredential = usesCodexLogin
    ? true
    : usesAnthropicProMax
      ? settings.anthropicRefreshToken.trim().length > 0
      : providerCredential.trim().length > 0;
  const [localError, setLocalError] = useState<string | null>(null);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );

  const {
    messages,
    sendMessage,
    status,
    stop,
    addToolApprovalResponse,
    clearError,
  } = useChat({
    id: `thread:${thread.id}`,
    messages: threadMessages,
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
    transport,
  });

  useEffect(() => {
    setMessagesForThread(thread.id, messages);
  }, [messages, setMessagesForThread, thread.id]);

  // Auto-approve writeFile tool calls when autoAcceptEdits is enabled
  useEffect(() => {
    if (!autoAcceptEdits) return;
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
  }, [messages, autoAcceptEdits, addToolApprovalResponse]);

  const selectedModel = selectedModelOption?.id ?? "";
  const selectedModelLabel = selectedModelOption?.label ?? selectedModel;
  const selectedModelValue = selectedModelOption?.id;
  const availableReasoningEfforts = getModelReasoningEfforts(
    selectedProvider,
    selectedModel,
  );
  const reasoningEffortOptions = REASONING_EFFORT_OPTIONS.filter((option) =>
    availableReasoningEfforts.includes(option.value),
  );
  const selectedReasoningEffort = normalizeReasoningEffort(
    thread.reasoningEffort,
  );
  const selectedReasoningLabel =
    reasoningEffortOptions.find(
      (option) => option.value === selectedReasoningEffort,
    )?.label ??
    REASONING_EFFORT_OPTIONS.find(
      (option) => option.value === selectedReasoningEffort,
    )?.label ??
    "Reasoning";
  const selectedChatMode = normalizeChatMode(thread.chatMode);
  const selectedChatModeLabel =
    CHAT_MODE_OPTIONS.find((option) => option.value === selectedChatMode)
      ?.label ?? "Build";

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
      : selectedProvider === "openai"
        ? `openai:${selectedModel}`
        : `google:${selectedModel}`;

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      setLocalError(null);
      clearError();

      const activeOption =
        allModelOptions.find(
          (option) =>
            option.provider === thread.provider && option.id === thread.model,
        ) ?? allModelOptions[0];
      const activeProvider = activeOption?.provider ?? selectedProvider;
      const activeModel = activeOption?.id ?? "";
      const activeProviderAuthMode = getProviderAuthMode(
        activeProvider,
        settings,
      );
      const activeProviderCredential = getProviderCredential(
        activeProvider,
        settings,
      );
      const activeUsesCodexLogin =
        activeProvider === "openai" && activeProviderAuthMode === "codex";
      const activeUsesAnthropicProMax =
        activeProvider === "anthropic" &&
        activeProviderAuthMode === "claudeProMax";
      const activeProviderConnected =
        connectedProviders.includes(activeProvider);
      let requestCredential = activeProviderCredential;
      let anthropicOAuth:
        | {
            accessToken: string;
            expiresAt: number;
            refreshToken: string;
          }
        | undefined;

      if (!activeProviderConnected) {
        setLocalError(
          "Connect a provider in Settings before sending a prompt.",
        );
        return;
      }

      if (!activeModel) {
        setLocalError("Enable at least one model in Settings first.");
        return;
      }

      if (
        activeUsesAnthropicProMax &&
        settings.anthropicRefreshToken.trim().length === 0
      ) {
        setLocalError(
          "Complete Claude Pro/Max login in Settings before sending a prompt.",
        );
        return;
      }

      if (activeUsesAnthropicProMax) {
        let nextAccessToken = settings.anthropicAccessToken.trim();
        let nextRefreshToken = settings.anthropicRefreshToken.trim();
        let nextExpiresAt =
          typeof settings.anthropicAccessTokenExpiresAt === "number"
            ? settings.anthropicAccessTokenExpiresAt
            : Date.now() - 1;

        const needsRefresh =
          !nextAccessToken || nextExpiresAt <= Date.now() + 15_000;

        if (needsRefresh) {
          const refreshResponse = await fetch("/api/anthropic-oauth/refresh", {
            body: JSON.stringify({ refreshToken: nextRefreshToken }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });

          if (!refreshResponse.ok) {
            const message = await refreshResponse.text();
            setLocalError(
              message || "Unable to refresh Claude Pro/Max access token.",
            );
            return;
          }

          const refreshed = (await refreshResponse.json()) as {
            accessToken?: string;
            expiresAt?: number;
            refreshToken?: string;
          };

          nextAccessToken = refreshed.accessToken?.trim() ?? "";
          nextRefreshToken = refreshed.refreshToken?.trim() ?? "";
          nextExpiresAt =
            typeof refreshed.expiresAt === "number"
              ? refreshed.expiresAt
              : Date.now() - 1;

          setSettings((previous) => ({
            ...previous,
            anthropicAccessToken: nextAccessToken,
            anthropicAccessTokenExpiresAt: nextExpiresAt,
            anthropicRefreshToken: nextRefreshToken,
          }));
        }

        if (!nextAccessToken || !nextRefreshToken) {
          setLocalError(
            "Complete Claude Pro/Max login in Settings before sending a prompt.",
          );
          return;
        }

        requestCredential = nextAccessToken;
        anthropicOAuth = {
          accessToken: nextAccessToken,
          expiresAt: nextExpiresAt,
          refreshToken: nextRefreshToken,
        };
      }

      if (!requestCredential && !activeUsesCodexLogin) {
        setLocalError(
          `Add a ${activeProvider === "anthropic" ? "Anthropic" : activeProvider === "gemini" ? "Gemini" : "OpenAI"} credential in Settings first.`,
        );
        return;
      }

      if (!prompt.text.trim() && prompt.files.length === 0) {
        return;
      }

      if (threadMessages.length === 0) {
        updateThread(thread.id, (current) => ({
          ...current,
          title: inferThreadTitle(prompt.text),
        }));
      }

      await sendMessage(
        {
          files: prompt.files,
          text: prompt.text,
        },
        {
          body: {
            authMode: activeProviderAuthMode,
            anthropicOAuth,
            chatMode: selectedChatMode,
            credential: requestCredential,
            model: activeModel,
            projectPath: project.path,
            provider: activeProvider,
            reasoningEffort: selectedReasoningEffort,
          },
        },
      );
    },
    [
      allModelOptions,
      clearError,
      threadMessages,
      connectedProviders,
      project.path,
      selectedChatMode,
      selectedProvider,
      selectedReasoningEffort,
      sendMessage,
      setSettings,
      settings,
      thread,
      updateThread,
    ],
  );

  const isStreaming = status === "streaming";
  const isProcessing = status === "submitted" || status === "streaming";

  // Track elapsed thinking time, only shown during lulls (no new data)
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const [showThinking, setShowThinking] = useState(false);
  const lullStartRef = useRef<number | null>(null);
  const lullTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Build a fingerprint that changes whenever new data arrives
  const lastMessage = messages[messages.length - 1];
  const lastPart = lastMessage?.parts?.[lastMessage.parts.length - 1];
  const streamFingerprint = `${messages.length}:${lastMessage?.parts?.length ?? 0}:${
    lastPart && "text" in lastPart ? (lastPart.text as string).length : 0
  }`;

  useEffect(() => {
    if (!isProcessing) {
      // Not processing — reset everything
      setShowThinking(false);
      setThinkingSeconds(0);
      lullStartRef.current = null;
      if (lullTimerRef.current) clearTimeout(lullTimerRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }

    // Data changed while processing — hide and reset, wait for next lull
    setShowThinking(false);
    setThinkingSeconds(0);
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (lullTimerRef.current) clearTimeout(lullTimerRef.current);

    lullTimerRef.current = setTimeout(() => {
      lullStartRef.current = Date.now();
      setShowThinking(true);
      setThinkingSeconds(1);
      intervalRef.current = setInterval(() => {
        if (lullStartRef.current !== null) {
          setThinkingSeconds(
            Math.floor((Date.now() - lullStartRef.current) / 1000) + 1,
          );
        }
      }, 1000);
    }, 1000);

    return () => {
      if (lullTimerRef.current) clearTimeout(lullTimerRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isProcessing, streamFingerprint]);

  const messageContent = useMemo(() => {
    return messages.map((message, messageIndex) => {
      if (message.role === "user") {
        return (
          <Message from="user" key={message.id}>
            <MessageContent>
              <MessageResponse>
                {renderUserMessageText(message)}
              </MessageResponse>
            </MessageContent>
          </Message>
        );
      }

      const isLastMessage = messageIndex === messages.length - 1;

      // Group source parts for collapsible Sources display
      const sourceParts = message.parts.filter(
        (part) => part.type === "source-url" || part.type === "source-document",
      );
      const nonSourceParts = message.parts.filter(
        (part) => part.type !== "source-url" && part.type !== "source-document",
      );

      return (
        <Message from={message.role} key={message.id}>
          {sourceParts.length > 0 ? (
            <Sources>
              <SourcesTrigger count={sourceParts.length} />
              <SourcesContent>
                {sourceParts.map((part, index) => {
                  if (part.type === "source-url") {
                    return (
                      <Source
                        href={part.url}
                        key={`${message.id}-source-${index}`}
                        title={part.url}
                      />
                    );
                  }
                  if (part.type === "source-document") {
                    return (
                      <Source
                        key={`${message.id}-source-${index}`}
                        title={part.title ?? part.filename ?? "Document"}
                      />
                    );
                  }
                  return null;
                })}
              </SourcesContent>
            </Sources>
          ) : null}
          <MessageContent className="gap-3">
            {(() => {
              // Group consecutive chip-eligible parts into flex-wrap rows
              const elements: React.ReactNode[] = [];
              let chipGroup: {
                part: (typeof nonSourceParts)[number];
                index: number;
              }[] = [];

              const flushChipGroup = () => {
                if (chipGroup.length === 0) return;
                const group = chipGroup;
                elements.push(
                  <div
                    className="flex flex-wrap items-start gap-2"
                    key={`chip-group-${group[0].index}`}
                  >
                    {group.map(({ part: chipPart, index: chipIndex }) => {
                      const toolType = chipPart.type as string;
                      const toolName = toolType.startsWith("tool-")
                        ? toolType.slice(5)
                        : "";
                      const key = getMessagePartKey(
                        message.id,
                        chipPart as Record<string, unknown>,
                        chipIndex,
                      );
                      const chipPart_ = chipPart as Parameters<
                        typeof ReadFileChip
                      >[0]["part"];
                      if (toolName === "readFile") {
                        return <ReadFileChip key={key} part={chipPart_} />;
                      }
                      if (toolName === "listFiles") {
                        return <ListFilesChip key={key} part={chipPart_} />;
                      }
                      if (toolName === "writeFile") {
                        return (
                          <WriteFileChip
                            key={key}
                            onToolApproval={addToolApprovalResponse}
                            part={chipPart_}
                          />
                        );
                      }
                      return <SearchInFilesChip key={key} part={chipPart_} />;
                    })}
                  </div>,
                );
                chipGroup = [];
              };

              // Check if a part renders as invisible (null) and should
              // be skipped so it doesn't break chip group continuity
              const isInvisiblePart = (
                part: (typeof nonSourceParts)[number],
                partIndex: number,
              ) => {
                if (part.type === "step-start") return true;
                if (
                  part.type === "reasoning" &&
                  "text" in part &&
                  typeof part.text === "string" &&
                  part.text.trim().length === 0 &&
                  !(
                    isStreaming &&
                    isLastMessage &&
                    partIndex === nonSourceParts.length - 1
                  )
                )
                  return true;
                if (
                  part.type === "text" &&
                  "text" in part &&
                  typeof part.text === "string" &&
                  part.text.trim().length === 0
                )
                  return true;
                return false;
              };

              for (let i = 0; i < nonSourceParts.length; i++) {
                const part = nonSourceParts[i];
                if (isChipToolPart(part)) {
                  chipGroup.push({ part, index: i });
                } else if (isInvisiblePart(part, i)) {
                } else {
                  flushChipGroup();
                  const isLastPart = i === nonSourceParts.length - 1;
                  const isPartStreaming =
                    isStreaming && isLastMessage && isLastPart;
                  elements.push(
                    <AssistantMessagePart
                      chatMode={selectedChatMode}
                      key={getMessagePartKey(
                        message.id,
                        part as Record<string, unknown>,
                        i,
                      )}
                      isStreaming={isPartStreaming}
                      part={part}
                    />,
                  );
                }
              }
              flushChipGroup();
              return elements;
            })()}
          </MessageContent>
        </Message>
      );
    });
  }, [messages, isStreaming, addToolApprovalResponse, selectedChatMode]);

  return (
    <div id="chat-panel" className="flex h-full min-h-0 flex-col">
      <Conversation
        id="chat-conversation"
        className="min-h-0 flex-1"
        initial={false}
      >
        <ConversationContent
          id="chat-conversation-content"
          className="mx-auto w-full max-w-[700px] gap-4 px-0 pr-2 pt-3 pb-4"
        >
          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4">
              <ConversationEmptyState
                description="Ask the assistant to inspect, edit, or create files in the active project."
                title="No chat messages yet"
              />
            </div>
          ) : (
            messageContent
          )}
          {isProcessing && showThinking ? (
            <div className="py-2">
              <Shimmer as="span" className="text-sm" duration={1.5}>
                {`Thinking for ${thinkingSeconds} second${thinkingSeconds !== 1 ? "s" : ""}`}
              </Shimmer>
            </div>
          ) : null}
        </ConversationContent>
        <ConversationScrollMemory
          scrollPositionsRef={scrollPositionsRef}
          threadId={thread.id}
        />
        <ConversationScrollButton />
      </Conversation>

      {localError ? (
        <div className="shrink-0 px-2 pb-1">
          <div className="mx-auto flex w-full max-w-[700px] items-start gap-2 rounded-md border border-red-500/20 bg-red-500/8 px-3 py-2 text-sm text-red-700">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{localError}</span>
            <button
              type="button"
              className="mt-0.5 shrink-0 rounded p-0.5 hover:bg-red-500/10"
              onClick={() => {
                setLocalError(null);
                clearError();
              }}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      <div id="chat-prompt" className="shrink-0 px-2 pb-2">
        <div className="mx-auto w-full max-w-[700px]">
          <div className="overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md">
            {/* ── Prompt Input ──────────────────────────────────────── */}
            <PromptInput
              id="chat-prompt-input"
              className="w-full [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:backdrop-blur-none [&_[data-slot=input-group]]:ring-0 [&_[data-slot=input-group]]:focus-within:ring-0 [&_[data-slot=input-group]]:focus-within:border-0"
              onSubmit={handleSubmit}
            >
              <PromptInputBody>
                <PromptInputTextarea
                  className="min-h-[80px] border-none bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
                  placeholder="Ask anything..."
                />
              </PromptInputBody>
              <PromptInputFooter className="items-center">
                <PromptInputTools>
                  <PromptInputActionMenu>
                    <PromptInputActionMenuTrigger tooltip="Attach file" />
                    <PromptInputActionMenuContent>
                      <PromptInputActionAddAttachments />
                    </PromptInputActionMenuContent>
                  </PromptInputActionMenu>
                </PromptInputTools>
                <PromptInputSubmit
                  className="size-8 rounded-md"
                  disabled={
                    !isProviderConnected ||
                    !hasProviderCredential ||
                    selectedModel === ""
                  }
                  onStop={stop}
                  status={status}
                />
              </PromptInputFooter>
            </PromptInput>

            {/* ── Options Row ───────────────────────────────────────── */}
            <div className="flex items-center gap-1 border-t border-foreground/10 px-2 py-1.5">
              {/* Plan / Build selector */}
              <Select
                onValueChange={(value) => {
                  updateThread(thread.id, (current) => ({
                    ...current,
                    chatMode: value as ChatMode,
                  }));
                }}
                value={selectedChatMode}
              >
                <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                  <SelectValue>{selectedChatModeLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent className="text-xs" side="top">
                  {CHAT_MODE_OPTIONS.map((option) => (
                    <SelectItem
                      className="text-xs"
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Model selector */}
              <Select
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  const matchingOptions = allModelOptions.filter(
                    (option) => option.id === value,
                  );
                  const nextOption =
                    matchingOptions.find(
                      (option) => option.provider === thread.provider,
                    ) ?? matchingOptions[0];
                  if (!nextOption) return;

                  updateThread(thread.id, (current) => ({
                    ...current,
                    model: nextOption.id,
                    provider: nextOption.provider,
                  }));
                }}
                value={selectedModelValue}
              >
                <SelectTrigger
                  className="h-7 w-auto max-w-[260px] gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
                  disabled={allModelOptions.length === 0}
                >
                  <SelectValue placeholder="Model">
                    <span className="flex items-center gap-1.5">
                      <ProviderIcon
                        className="size-3.5 shrink-0 text-muted-foreground/70"
                        provider={selectedProvider}
                      />
                      <span className="truncate">{selectedModelLabel}</span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent
                  alignItemWithTrigger={false}
                  className="text-xs"
                  side="top"
                >
                  {groupedModelOptions.map((group) => (
                    <SelectGroup key={group.provider}>
                      {connectedProviders.length > 1 && (
                        <SelectLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                          {group.label}
                        </SelectLabel>
                      )}
                      {group.models.map((option) => (
                        <SelectItem
                          className="text-xs"
                          key={`${option.provider}:${option.id}`}
                          value={option.id}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>

              {/* Reasoning effort selector */}
              {reasoningEffortOptions.length > 0 && (
                <Select
                  onValueChange={(value) => {
                    updateThread(thread.id, (current) => ({
                      ...current,
                      reasoningEffort: value as ReasoningEffort,
                    }));
                  }}
                  value={selectedReasoningEffort}
                >
                  <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                    <span className="truncate">{selectedReasoningLabel}</span>
                  </SelectTrigger>
                  <SelectContent className="text-xs" side="top">
                    {reasoningEffortOptions.map((option) => (
                      <SelectItem
                        className="text-xs"
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              {/* Auto-accept edits toggle */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      className={cn(
                        "rounded p-1 transition-colors",
                        autoAcceptEdits
                          ? "text-green-500 hover:text-green-600"
                          : "text-muted-foreground/40 hover:text-muted-foreground",
                      )}
                      onClick={() => setAutoAcceptEdits(!autoAcceptEdits)}
                      type="button"
                    />
                  }
                >
                  <CheckCheck className="size-4" />
                </TooltipTrigger>
                <TooltipContent>
                  {autoAcceptEdits
                    ? "Auto-accept edits (on)"
                    : "Auto-accept edits (off)"}
                </TooltipContent>
              </Tooltip>

              {/* Context usage indicator */}
              <Context
                maxTokens={contextWindow}
                modelId={modelId}
                usedTokens={estimatedUsedTokens}
              >
                <ContextTrigger className="ml-auto h-7 gap-1.5 border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground" />
                <ContextContent side="top" align="end">
                  <ContextContentHeader />
                  <ContextContentBody className="space-y-1.5">
                    <ContextInputUsage />
                    <ContextOutputUsage />
                    <ContextReasoningUsage />
                    <ContextCacheUsage />
                  </ContextContentBody>
                  <ContextContentFooter />
                </ContextContent>
              </Context>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
