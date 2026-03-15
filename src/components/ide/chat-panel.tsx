import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { CheckCheck } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
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
import { cn } from "@/lib/utils";
import type {
  ChatMode,
  ProjectConfig,
  ReasoningEffort,
  ThreadConfig,
} from "@/types/ide";
import { AssistantMessagePart } from "./assistant-message-part";
import { renderUserMessageText } from "./ide-state";
import { useIdeStore } from "./ide-store";
import {
  CHAT_MODE_OPTIONS,
  normalizeChatMode,
  normalizeReasoningEffort,
  REASONING_EFFORT_OPTIONS,
} from "./ide-types";

const EMPTY_MESSAGES: UIMessage[] = [];

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

  const { messages, sendMessage, status, stop } = useChat({
    id: `thread:${thread.id}`,
    messages: threadMessages,
    onError: (error) => {
      setLocalError(error.message);
    },
    transport,
  });

  useEffect(() => {
    setMessagesForThread(thread.id, messages);
  }, [messages, setMessagesForThread, thread.id]);

  const selectedModel = selectedModelOption?.id ?? "";
  const selectedModelLabel = selectedModelOption?.label ?? selectedModel;
  const selectedModelValue = selectedModelOption?.id;
  const selectedReasoningEffort = normalizeReasoningEffort(
    thread.reasoningEffort,
  );
  const selectedReasoningLabel =
    REASONING_EFFORT_OPTIONS.find(
      (option) => option.value === selectedReasoningEffort,
    )?.label ?? "Reasoning";
  const selectedChatMode = normalizeChatMode(thread.chatMode);
  const selectedChatModeLabel =
    CHAT_MODE_OPTIONS.find((option) => option.value === selectedChatMode)
      ?.label ?? "Build";

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      setLocalError(null);

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

  const messageContent = useMemo(() => {
    return messages.map((message) => {
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

      return (
        <Message from={message.role} key={message.id}>
          <MessageContent>
            {message.parts.map((part, index) => {
              return (
                <AssistantMessagePart
                  key={getMessagePartKey(
                    message.id,
                    part as Record<string, unknown>,
                    index,
                  )}
                  part={part}
                />
              );
            })}
          </MessageContent>
        </Message>
      );
    });
  }, [messages]);

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
            <ConversationEmptyState
              description="Ask the assistant to inspect, edit, or create files in the active project."
              title="No chat messages yet"
            />
          ) : (
            messageContent
          )}
        </ConversationContent>
        <ConversationScrollMemory
          scrollPositionsRef={scrollPositionsRef}
          threadId={thread.id}
        />
        <ConversationScrollButton />
      </Conversation>

      {localError ? (
        <div className="shrink-0 px-2 pb-1">
          <div className="mx-auto w-full max-w-[700px] rounded-md border border-red-500/20 bg-red-500/8 px-3 py-2 text-sm text-red-700">
            {localError}
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
                    <span className="flex items-center gap-1">
                      <span className="font-semibold text-muted-foreground/70">
                        {selectedProvider === "anthropic"
                          ? "A\\"
                          : selectedProvider === "gemini"
                            ? "G"
                            : "O"}
                      </span>
                      <span className="truncate">{selectedModelLabel}</span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="text-xs" side="top">
                  {allModelOptions.map((option) => (
                    <SelectItem
                      className="text-xs"
                      key={`${option.provider}:${option.id}`}
                      value={option.id}
                    >
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Reasoning effort selector */}
              <Select
                onValueChange={(value) => {
                  updateThread(thread.id, (current) => ({
                    ...current,
                    reasoningEffort: value as ReasoningEffort,
                  }));
                }}
                value={selectedReasoningEffort}
              >
                <SelectTrigger
                  className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground"
                  disabled={selectedProvider !== "openai"}
                >
                  <span className="truncate">{selectedReasoningLabel}</span>
                </SelectTrigger>
                <SelectContent className="text-xs" side="top">
                  {REASONING_EFFORT_OPTIONS.map((option) => (
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

              {/* Auto-accept edits toggle */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      className={cn(
                        "ml-auto rounded p-1 transition-colors",
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
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
