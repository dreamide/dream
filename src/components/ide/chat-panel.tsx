import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
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
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
  getConnectedProviders,
  getModelsForProvider,
  getProviderAuthMode,
  getProviderCredential,
} from "@/lib/ide-defaults";
import type { ProjectConfig, ReasoningEffort } from "@/types/ide";
import { AssistantMessagePart } from "./assistant-message-part";
import { renderUserMessageText } from "./ide-state";
import { useIdeStore } from "./ide-store";
import {
  normalizeReasoningEffort,
  REASONING_EFFORT_OPTIONS,
} from "./ide-types";

const ConversationScrollMemory = ({
  projectId,
  scrollPositionsRef,
}: {
  projectId: string;
  scrollPositionsRef: React.MutableRefObject<Record<string, number>>;
}) => {
  const { scrollRef, scrollToBottom, stopScroll } = useStickToBottomContext();

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const saveScroll = () => {
      scrollPositionsRef.current[projectId] = element.scrollTop;
    };

    saveScroll();
    element.addEventListener("scroll", saveScroll, { passive: true });

    return () => {
      saveScroll();
      element.removeEventListener("scroll", saveScroll);
    };
  }, [projectId, scrollPositionsRef, scrollRef]);

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;

      stopScroll();
      const savedScroll = scrollPositionsRef.current[projectId];

      if (typeof savedScroll === "number") {
        element.scrollTop = savedScroll;
        return;
      }

      void scrollToBottom("instant");
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [projectId, scrollPositionsRef, scrollRef, scrollToBottom, stopScroll]);

  return null;
};

export const ChatPanel = ({ project }: { project: ProjectConfig }) => {
  const settings = useIdeStore((s) => s.settings);
  const chats = useIdeStore((s) => s.chats);
  const setMessagesForProject = useIdeStore((s) => s.setMessagesForProject);
  const setSettings = useIdeStore((s) => s.setSettings);
  const updateProject = useIdeStore((s) => s.updateProject);
  const scrollPositionsRef = useRef<Record<string, number>>({});

  const connectedProviders = getConnectedProviders(settings);
  const allModelOptions = useMemo(() => {
    return connectedProviders.flatMap((provider) =>
      getModelsForProvider(provider, settings).map((model) => ({
        model,
        provider,
      })),
    );
  }, [connectedProviders, settings]);
  const selectedModelOption =
    allModelOptions.find(
      (option) =>
        option.provider === project.provider && option.model === project.model,
    ) ?? allModelOptions[0];
  const selectedProvider = selectedModelOption?.provider ?? project.provider;
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
  const credentialLabel = usesCodexLogin
    ? "Codex Login"
    : usesAnthropicProMax
      ? "Claude Pro/Max login"
      : "API key";
  const [localError, setLocalError] = useState<string | null>(null);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );

  const { messages, sendMessage, status, stop } = useChat({
    id: `project:${project.id}`,
    messages: chats[project.id] ?? [],
    onError: (error) => {
      setLocalError(error.message);
    },
    transport,
  });

  useEffect(() => {
    setMessagesForProject(project.id, messages);
  }, [project.id, messages, setMessagesForProject]);

  const selectedModel = selectedModelOption?.model ?? "";
  const selectedModelValue = selectedModelOption?.model;
  const selectedReasoningEffort = normalizeReasoningEffort(
    project.reasoningEffort,
  );
  const selectedReasoningLabel =
    REASONING_EFFORT_OPTIONS.find(
      (option) => option.value === selectedReasoningEffort,
    )?.label ?? "Reasoning";

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      setLocalError(null);

      const activeOption =
        allModelOptions.find(
          (option) =>
            option.provider === project.provider &&
            option.model === project.model,
        ) ?? allModelOptions[0];
      const activeProvider = activeOption?.provider ?? selectedProvider;
      const activeModel = activeOption?.model ?? "";
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
      const activeCredentialLabel = activeUsesCodexLogin
        ? "Codex Login"
        : activeUsesAnthropicProMax
          ? "Claude Pro/Max login"
          : "API key";
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
          `Add a ${activeProvider === "anthropic" ? "Anthropic" : "OpenAI"} ${activeCredentialLabel} in Settings first.`,
        );
        return;
      }

      if (!prompt.text.trim() && prompt.files.length === 0) {
        return;
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
      connectedProviders,
      project,
      selectedProvider,
      selectedReasoningEffort,
      sendMessage,
      setSettings,
      settings,
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
                  key={`${message.id}-part-${index}`}
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
    <div
      id="chat-panel"
      className="relative flex h-full min-h-0 flex-col"
    >
      <Conversation id="chat-conversation" className="min-h-0 flex-1" initial={false} key={project.id}>
        <ConversationContent id="chat-conversation-content" className="mx-auto w-full max-w-[800px] gap-4 px-0 pr-2 pt-3 pb-50">
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
          projectId={project.id}
          scrollPositionsRef={scrollPositionsRef}
        />
        <ConversationScrollButton className="bottom-56" />
      </Conversation>

      <div id="chat-prompt" className="pointer-events-none absolute right-4 bottom-2 left-2">
        <div className="mx-auto w-full max-w-[800px]">
          <PromptInput
            id="chat-prompt-input"
            className="pointer-events-auto w-full [&_[data-slot=input-group]]:rounded-lg [&_[data-slot=input-group]]:border-foreground/20 [&_[data-slot=input-group]]:bg-background/70 [&_[data-slot=input-group]]:backdrop-blur-2xl [&_[data-slot=input-group]]:shadow-md"
            onSubmit={handleSubmit}
          >
            <PromptInputBody>
              <PromptInputTextarea
                className="min-h-[104px] border-none bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
                placeholder={`Ask AI to update ${project.name}...`}
              />
            </PromptInputBody>
            <PromptInputFooter className="items-center">
              <PromptInputTools className="gap-1.5 overflow-x-auto">
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger tooltip="Attach file" />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments />
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>

                <PromptInputSelect
                  onValueChange={(value) => {
                    if (typeof value !== "string") return;
                    const matchingOptions = allModelOptions.filter(
                      (option) => option.model === value,
                    );
                    const nextOption =
                      matchingOptions.find(
                        (option) => option.provider === project.provider,
                      ) ?? matchingOptions[0];
                    if (!nextOption) return;

                    updateProject(project.id, (current) => ({
                      ...current,
                      model: nextOption.model,
                      provider: nextOption.provider,
                    }));
                  }}
                  value={selectedModelValue}
                >
                  <PromptInputSelectTrigger
                    className="h-8 min-w-[180px] max-w-[260px] px-2 text-xs"
                    disabled={allModelOptions.length === 0}
                  >
                    <PromptInputSelectValue placeholder="Model" />
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent className="text-xs" side="top">
                    {allModelOptions.map((option) => (
                      <PromptInputSelectItem
                        className="text-xs"
                        key={`${option.provider}:${option.model}`}
                        value={option.model}
                      >
                        {option.model}
                      </PromptInputSelectItem>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>

                <PromptInputSelect
                  onValueChange={(value) => {
                    updateProject(project.id, (current) => ({
                      ...current,
                      reasoningEffort: value as ReasoningEffort,
                    }));
                  }}
                  value={selectedReasoningEffort}
                >
                  <PromptInputSelectTrigger
                    className="h-8 min-w-[120px] px-2 text-xs"
                    disabled={selectedProvider !== "openai"}
                  >
                    <span className="truncate">{selectedReasoningLabel}</span>
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent className="text-xs" side="top">
                    {REASONING_EFFORT_OPTIONS.map((option) => (
                      <PromptInputSelectItem
                        className="text-xs"
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </PromptInputSelectItem>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>
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
        </div>
      </div>
    </div>
  );
};
