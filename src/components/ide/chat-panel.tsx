import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import {
  getConnectedProviders,
  getDefaultModelForProvider,
  getModelsForProvider,
  getProviderAuthMode,
  getProviderCredential,
} from "@/lib/ide-defaults";
import type { AiProvider, ProjectConfig, ReasoningEffort } from "@/types/ide";
import { AssistantMessagePart } from "./assistant-message-part";
import { renderUserMessageText } from "./ide-state";
import { useIdeStore } from "./ide-store";
import {
  getProviderLabel,
  normalizeReasoningEffort,
  REASONING_EFFORT_OPTIONS,
} from "./ide-types";

export const ChatPanel = ({ project }: { project: ProjectConfig }) => {
  const settings = useIdeStore((s) => s.settings);
  const chats = useIdeStore((s) => s.chats);
  const setMessagesForProject = useIdeStore((s) => s.setMessagesForProject);
  const updateProject = useIdeStore((s) => s.updateProject);

  const connectedProviders = getConnectedProviders(settings);
  const isProviderConnected = connectedProviders.includes(project.provider);
  const providerAuthMode = getProviderAuthMode(project.provider, settings);
  const providerCredential = getProviderCredential(project.provider, settings);
  const usesCodexLogin =
    project.provider === "openai" && providerAuthMode === "codex";
  const credentialLabel = usesCodexLogin ? "Codex Login" : "API key";
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

  const models = getModelsForProvider(project.provider, settings);
  const selectedModel = models.includes(project.model)
    ? project.model
    : (models[0] ?? "");
  const selectedReasoningEffort = normalizeReasoningEffort(
    project.reasoningEffort,
  );

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
      setLocalError(null);

      const activeModel = models.includes(project.model)
        ? project.model
        : (models[0] ?? "");

      if (!isProviderConnected) {
        setLocalError(
          "Connect a provider in Settings before sending a prompt.",
        );
        return;
      }

      if (!activeModel) {
        setLocalError("Enable at least one model in Settings first.");
        return;
      }

      if (!providerCredential && !usesCodexLogin) {
        setLocalError(
          `Add a ${project.provider === "anthropic" ? "Anthropic" : "OpenAI"} ${credentialLabel} in Settings first.`,
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
            authMode: providerAuthMode,
            credential: providerCredential,
            model: activeModel,
            projectPath: project.path,
            provider: project.provider,
            reasoningEffort: selectedReasoningEffort,
          },
        },
      );
    },
    [
      credentialLabel,
      models,
      isProviderConnected,
      project,
      providerAuthMode,
      providerCredential,
      selectedReasoningEffort,
      sendMessage,
      usesCodexLogin,
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
    <div className="flex h-full flex-col">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-4 p-3">
          {messages.length === 0 ? (
            <ConversationEmptyState
              description="Ask the assistant to inspect, edit, or create files in the active project."
              title="No chat messages yet"
            />
          ) : (
            messageContent
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="p-3">
        <PromptInput
          className="w-full rounded-2xl bg-background px-2 pt-2 pb-1"
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
                  updateProject(project.id, (current) => ({
                    ...current,
                    model: getDefaultModelForProvider(
                      value as AiProvider,
                      settings,
                    ),
                    provider: value as AiProvider,
                  }));
                }}
                value={isProviderConnected ? project.provider : undefined}
              >
                <PromptInputSelectTrigger
                  className="h-8 min-w-[110px] px-2 text-xs"
                  disabled={connectedProviders.length === 0}
                >
                  <PromptInputSelectValue placeholder="Provider" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {connectedProviders.map((provider) => (
                    <PromptInputSelectItem key={provider} value={provider}>
                      {getProviderLabel(provider)}
                    </PromptInputSelectItem>
                  ))}
                </PromptInputSelectContent>
              </PromptInputSelect>

              <PromptInputSelect
                onValueChange={(value) => {
                  updateProject(project.id, (current) => ({
                    ...current,
                    model: value as string,
                  }));
                }}
                value={selectedModel || undefined}
              >
                <PromptInputSelectTrigger
                  className="h-8 min-w-[180px] max-w-[260px] px-2 text-xs"
                  disabled={models.length === 0}
                >
                  <PromptInputSelectValue placeholder="Model" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {models.map((model) => (
                    <PromptInputSelectItem key={model} value={model}>
                      {model}
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
                  disabled={project.provider !== "openai"}
                >
                  <PromptInputSelectValue placeholder="Reasoning" />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  {REASONING_EFFORT_OPTIONS.map((option) => (
                    <PromptInputSelectItem
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
              className="size-8 rounded-full"
              disabled={
                !isProviderConnected ||
                (!providerCredential && !usesCodexLogin) ||
                selectedModel === ""
              }
              onStop={stop}
              status={status}
            />
          </PromptInputFooter>
        </PromptInput>

        <div className="mt-2 flex items-center gap-2">
          {!isProviderConnected ? (
            <Badge variant="destructive">No provider connected</Badge>
          ) : !providerCredential && !usesCodexLogin ? (
            <Badge variant="destructive">Missing {credentialLabel}</Badge>
          ) : selectedModel === "" ? (
            <Badge variant="outline">No model enabled</Badge>
          ) : null}
        </div>

        {localError ? (
          <p className="mt-2 text-destructive text-xs">{localError}</p>
        ) : null}
      </div>
    </div>
  );
};
