import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  AlertCircle,
  Archive,
  Ellipsis,
  FilePenLine,
  PaperclipIcon,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import {
  type FormEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  Context,
  ContextCacheUsage,
  ContextContent,
  ContextContentBody,
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
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { ProviderIcon } from "@/components/ai-elements/provider-icons";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GlowBorder } from "@/components/ui/glow-border";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import type {
  AiProvider,
  ProjectConfig,
  ReasoningEffort,
  ThreadConfig,
} from "@/types/ide";
import {
  AgentChip,
  AssistantMessagePart,
  getChipToolKind,
  isChipToolPart,
  ListFilesChip,
  ReadFileChip,
  RunCommandChip,
  SearchInFilesChip,
  WriteFileChip,
} from "./assistant-message-part";
import { BranchSwitcher } from "./branch-switcher";
import { useIdeStore } from "./ide-store";
import {
  CLAUDE_PERMISSION_MODE_OPTIONS,
  type ClaudePermissionMode,
  CODEX_PERMISSION_MODE_OPTIONS,
  type CodexPermissionMode,
  getClaudePermissionModeLabel,
  getCodexPermissionModeLabel,
  normalizeReasoningEffort,
  REASONING_EFFORT_OPTIONS,
} from "./ide-types";

const EMPTY_MESSAGES: UIMessage[] = [];

type RenameTarget = {
  id: string;
  name: string;
};

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

type ChatMessageMetadata = {
  remoteConversationId?: string;
  remoteConversationModel?: string;
};

const MESSAGE_RENDER_STYLE = {
  containIntrinsicSize: "240px",
  contentVisibility: "auto",
} as const;

const ConversationScrollMemory = ({ isActive }: { isActive: boolean }) => {
  const { scrollRef, stopScroll } = useStickToBottomContext();

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;

      stopScroll();
      element.scrollTop = element.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isActive, scrollRef, stopScroll]);

  return null;
};

const inferThreadTitle = (promptText: string): string => {
  const collapsed = promptText.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "New thread";
  }

  return collapsed.slice(0, 60);
};

const PromptAttachments = () => {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <Attachments className="w-full px-3 pt-3" variant="inline">
      {attachments.files.map((file) => (
        <Attachment
          data={file}
          key={file.id}
          onRemove={() => attachments.remove(file.id)}
        >
          <AttachmentPreview />
          <AttachmentInfo />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
};

const UserMessageContent = ({ message }: { message: UIMessage }) => {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const attachments = parts.flatMap((part) => {
    if (!part || typeof part !== "object" || part.type !== "file") {
      return [];
    }

    const label =
      (typeof part.filename === "string" && part.filename.trim()) ||
      (typeof part.mediaType === "string" && part.mediaType.trim()) ||
      "attachment";

    return [
      {
        key:
          (typeof part.url === "string" && part.url) ||
          `${label}-${typeof part.mediaType === "string" ? part.mediaType : "file"}`,
        label,
      },
    ];
  });
  const text = parts
    .flatMap((part) => {
      if (!part || typeof part !== "object" || part.type !== "text") {
        return [];
      }

      const value = typeof part.text === "string" ? part.text.trim() : "";
      return value ? [value] : [];
    })
    .join("\n\n");

  return (
    <>
      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map(({ key, label }) => (
            <Badge
              className="max-w-full gap-1.5 rounded-full bg-muted px-2.5 py-1 font-medium text-foreground"
              key={key}
              variant="secondary"
            >
              <PaperclipIcon className="size-3 shrink-0" />
              <span className="truncate font-mono text-xs">
                Attached file: {label}
              </span>
            </Badge>
          ))}
        </div>
      ) : null}
      {text ? <MessageResponse>{text}</MessageResponse> : null}
    </>
  );
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

type ToolApprovalResponder = (response: {
  id: string;
  approved: boolean;
}) => void;

type ThreadMessageProps = {
  addToolApprovalResponse: ToolApprovalResponder;
  isLastMessage: boolean;
  isStreaming: boolean;
  message: UIMessage;
};

const ThreadMessage = memo(
  ({
    addToolApprovalResponse,
    isLastMessage,
    isStreaming,
    message,
  }: ThreadMessageProps) => {
    if (message.role === "user") {
      return (
        <Message from="user" style={MESSAGE_RENDER_STYLE}>
          <MessageContent>
            <UserMessageContent message={message} />
          </MessageContent>
        </Message>
      );
    }

    const sourceParts = message.parts.filter(
      (part) => part.type === "source-url" || part.type === "source-document",
    );
    const nonSourceParts = message.parts.filter(
      (part) => part.type !== "source-url" && part.type !== "source-document",
    );

    return (
      <Message from={message.role} style={MESSAGE_RENDER_STYLE}>
        {sourceParts.length > 0 ? (
          <Sources>
            <SourcesTrigger count={sourceParts.length} />
            <SourcesContent>
              {sourceParts.map((part) => {
                if (part.type === "source-url") {
                  return (
                    <Source
                      href={part.url}
                      key={`${message.id}-source-url-${part.url}`}
                      title={part.url}
                    />
                  );
                }
                if (part.type === "source-document") {
                  const title = part.title ?? part.filename ?? "Document";
                  return (
                    <Source
                      key={`${message.id}-source-document-${title}`}
                      title={title}
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
                    const key = getMessagePartKey(
                      message.id,
                      chipPart as Record<string, unknown>,
                      chipIndex,
                    );
                    const chipPart_ = chipPart as Parameters<
                      typeof ReadFileChip
                    >[0]["part"];
                    const chipToolKind = getChipToolKind(chipPart_);

                    if (chipToolKind === "command") {
                      return <RunCommandChip key={key} part={chipPart_} />;
                    }
                    if (chipToolKind === "agent") {
                      return <AgentChip key={key} part={chipPart_} />;
                    }
                    if (chipToolKind === "read") {
                      return <ReadFileChip key={key} part={chipPart_} />;
                    }
                    if (chipToolKind === "list") {
                      return <ListFilesChip key={key} part={chipPart_} />;
                    }
                    if (chipToolKind === "write") {
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
  },
  (prev: ThreadMessageProps, next: ThreadMessageProps) =>
    prev.message === next.message &&
    prev.isLastMessage === next.isLastMessage &&
    prev.isStreaming === next.isStreaming &&
    prev.addToolApprovalResponse === next.addToolApprovalResponse,
);

ThreadMessage.displayName = "ThreadMessage";

export const ChatPanel = ({
  isActive,
  project,
  thread,
}: {
  isActive: boolean;
  project: ProjectConfig;
  thread: ThreadConfig;
}) => {
  const settings = useIdeStore((s) => s.settings);
  const threadMessages = useIdeStore(
    (s) => s.chats[thread.id] ?? EMPTY_MESSAGES,
  );
  const providerModels = useIdeStore((s) => s.providerModels);
  const claudePermissionMode = useIdeStore((s) => s.claudePermissionMode);
  const setClaudePermissionMode = useIdeStore((s) => s.setClaudePermissionMode);
  const codexPermissionMode = useIdeStore((s) => s.codexPermissionMode);
  const setCodexPermissionMode = useIdeStore((s) => s.setCodexPermissionMode);
  const setMessagesForThread = useIdeStore((s) => s.setMessagesForThread);
  const updateThread = useIdeStore((s) => s.updateThread);
  const closeThread = useIdeStore((s) => s.closeThread);
  const archiveThread = useIdeStore((s) => s.archiveThread);
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[project.id] ?? 0,
  );
  useProjectGitStatus(project.path, gitRefreshKey);
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
        reasoningEfforts: model.reasoningEfforts,
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
  const isProviderInstalled =
    providerModels[selectedProvider]?.installed ?? false;
  const [localError, setLocalError] = useState<string | null>(null);
  const [threadMenuOpen, setThreadMenuOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");

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
    onFinish: ({ message }) => {
      const metadata = message.metadata as ChatMessageMetadata | undefined;
      const remoteConversationId = metadata?.remoteConversationId?.trim();

      if (!remoteConversationId) {
        return;
      }

      updateThread(thread.id, (current) => ({
        ...current,
        remoteConversationId,
        remoteConversationModel:
          metadata?.remoteConversationModel ?? current.model,
      }));
    },
    transport,
  });

  useEffect(() => {
    setMessagesForThread(thread.id, messages);
  }, [messages, setMessagesForThread, thread.id]);

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
  const normalizedThreadReasoningEffort = normalizeReasoningEffort(
    thread.reasoningEffort,
  );
  const selectedReasoningEffort =
    availableReasoningEfforts.length === 0
      ? normalizedThreadReasoningEffort
      : availableReasoningEfforts.includes(normalizedThreadReasoningEffort)
        ? normalizedThreadReasoningEffort
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

      if (!prompt.text.trim() && prompt.files.length === 0) {
        return;
      }

      if (threadMessages.length === 0) {
        updateThread(thread.id, (current) => ({
          ...current,
          title: inferThreadTitle(prompt.text),
        }));
      }

      const submittedThreadId = thread.id;
      useIdeStore.getState().setThreadStreaming(submittedThreadId, true);
      try {
        await sendMessage(
          {
            files: prompt.files,
            text: prompt.text,
          },
          {
            body: {
              claudePermissionMode,
              codexPermissionMode,
              model: activeModel,
              projectPath: project.path,
              provider: activeProvider,
              reasoningEffort: selectedReasoningEffort,
              remoteConversationId: thread.remoteConversationId,
              remoteConversationModel: thread.remoteConversationModel,
              threadId: thread.id,
            },
          },
        );
      } finally {
        useIdeStore.getState().setThreadStreaming(submittedThreadId, false);
      }
    },
    [
      allModelOptions,
      claudePermissionMode,
      codexPermissionMode,
      clearError,
      threadMessages,
      providerModels,
      project.path,
      selectedProvider,
      selectedReasoningEffort,
      sendMessage,
      thread,
      updateThread,
    ],
  );

  const isStreaming = status === "streaming";
  const isProcessing = status === "submitted" || status === "streaming";

  const closeRenameDialog = useCallback(() => {
    setRenameTarget(null);
    setRenameValue("");
  }, []);

  const handleRenameThread = useCallback(() => {
    setRenameTarget({ id: thread.id, name: thread.title });
    setRenameValue(thread.title);
  }, [thread.id, thread.title]);

  const handleRenameSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const nextName = renameValue.trim();
      if (!renameTarget || !nextName) {
        return;
      }

      updateThread(renameTarget.id, (current) => ({
        ...current,
        title: nextName,
      }));
      closeRenameDialog();
    },
    [closeRenameDialog, renameTarget, renameValue, updateThread],
  );

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
    void streamFingerprint;

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
      lullStartRef.current = performance.now();
      setShowThinking(true);
      setThinkingSeconds(1);
      intervalRef.current = setInterval(() => {
        if (lullStartRef.current !== null) {
          setThinkingSeconds(
            Math.max(
              1,
              Math.floor((performance.now() - lullStartRef.current) / 1000) + 1,
            ),
          );
        }
      }, 1000);
    }, 1000);

    return () => {
      if (lullTimerRef.current) clearTimeout(lullTimerRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isProcessing, streamFingerprint]);

  return (
    <>
      <div id="chat-panel" className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 px-2 pt-2">
          <div className="mx-auto flex w-full max-w-[700px] items-center justify-between gap-3 border-b border-foreground/10 pb-2">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-sm">{thread.title}</p>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Context
                maxTokens={contextWindow}
                modelId={modelId}
                usedTokens={estimatedUsedTokens}
              >
                <ContextTrigger className="h-7 gap-1.5 border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground" />
                <ContextContent side="bottom" align="end">
                  <ContextContentHeader />
                  <ContextContentBody className="space-y-1.5">
                    <ContextInputUsage />
                    <ContextOutputUsage />
                    <ContextReasoningUsage />
                    <ContextCacheUsage />
                  </ContextContentBody>
                </ContextContent>
              </Context>

              <DropdownMenu onOpenChange={setThreadMenuOpen} open={threadMenuOpen}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      aria-label={`${thread.title} actions`}
                      className="h-8 w-8 p-0"
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    />
                  }
                >
                  <Ellipsis className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onClick={handleRenameThread}>
                    <FilePenLine className="size-4" />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => archiveThread(thread.id)}>
                    <Archive className="size-4" />
                    Archive
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => closeThread(thread.id)}
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>

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
              messages.map((message, messageIndex) => (
                <ThreadMessage
                  addToolApprovalResponse={addToolApprovalResponse}
                  isLastMessage={messageIndex === messages.length - 1}
                  isStreaming={isStreaming}
                  key={message.id}
                  message={message}
                />
              ))
            )}
            {isProcessing && showThinking ? (
              <div className="py-2">
                <Shimmer as="span" className="text-sm" duration={1.5}>
                  {`Thinking... ${thinkingSeconds} second${thinkingSeconds !== 1 ? "s" : ""}`}
                </Shimmer>
              </div>
            ) : null}
          </ConversationContent>
          <ConversationScrollMemory isActive={isActive} />
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
                  <PromptAttachments />
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
                  <div className="ml-auto flex items-center gap-2">
                    <GlowBorder className="rounded-md" disabled={!isProcessing}>
                      <PromptInputSubmit
                        className="size-8 rounded-md"
                        disabled={!isProviderInstalled || selectedModel === ""}
                        onStop={stop}
                        status={status}
                      />
                    </GlowBorder>
                  </div>
                </PromptInputFooter>
              </PromptInput>

              {/* ── Options Row ───────────────────────────────────────── */}
              <div className="flex items-center gap-1 border-t border-foreground/10 px-2 py-1.5">
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
                    remoteConversationId: null,
                    remoteConversationModel: null,
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
                      {groupedModelOptions.length > 1 && (
                        <SelectLabel className="text-sm font-semibold uppercase tracking-wider text-muted-foreground/60">
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

              {selectedProvider === "openai" ? (
                <Select
                  onValueChange={(value) => {
                    setCodexPermissionMode(value as CodexPermissionMode);
                  }}
                  value={codexPermissionMode}
                >
                  <SelectTrigger className="h-7 w-auto max-w-52 gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                    <Shield className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {getCodexPermissionModeLabel(codexPermissionMode)}
                    </span>
                  </SelectTrigger>
                  <SelectContent className="text-xs" side="top">
                    {CODEX_PERMISSION_MODE_OPTIONS.map((option) => (
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
              ) : selectedProvider === "anthropic" ? (
                <Select
                  onValueChange={(value) => {
                    setClaudePermissionMode(value as ClaudePermissionMode);
                  }}
                  value={claudePermissionMode}
                >
                  <SelectTrigger className="h-7 w-auto max-w-52 gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                    <Shield className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {getClaudePermissionModeLabel(claudePermissionMode)}
                    </span>
                  </SelectTrigger>
                  <SelectContent className="text-xs" side="top">
                    {CLAUDE_PERMISSION_MODE_OPTIONS.map((option) => (
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
              ) : null}

              <div className="ml-auto flex items-center gap-1">
                <BranchSwitcher
                  projectId={project.id}
                  projectPath={project.path}
                />
              </div>

              </div>
            </div>
          </div>
        </div>
      </div>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            closeRenameDialog();
          }
        }}
        open={renameTarget !== null}
      >
        <DialogContent className="sm:max-w-sm">
          <form className="space-y-4" onSubmit={handleRenameSubmit}>
            <DialogHeader>
              <DialogTitle>Rename thread</DialogTitle>
              <DialogDescription>
                Choose a new name for this thread.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder="Enter a name"
              value={renameValue}
            />
            <DialogFooter>
              <Button onClick={closeRenameDialog} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={renameValue.trim().length === 0} type="submit">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
