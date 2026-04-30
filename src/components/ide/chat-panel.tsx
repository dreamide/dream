import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  AlertCircle,
  CheckIcon,
  CopyIcon,
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
import {
  type StickToBottomContext,
  useStickToBottomContext,
} from "use-stick-to-bottom";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Sparkles from "@/components/ui/sparkles";
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
  ChatConfig,
  ProjectConfig,
  ReasoningEffort,
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
  TaskOutputChip,
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
type ChatMessagePart = UIMessage["parts"][number];

type RenameTarget = {
  id: string;
  name: string;
};

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

const CHAT_STREAM_UPDATE_THROTTLE_MS = 50;

type ChatMessageMetadata = {
  createdAt?: string;
  model?: string;
  modelLabel?: string;
  reasoningEffort?: string;
  reasoningLabel?: string;
  remoteConversationId?: string;
  remoteConversationModel?: string;
  remoteConversationProjectPath?: string;
};

const CHAT_CONTENT_BOTTOM_PADDING_PX = 88;

const scrollElementToChatBottom = (element: HTMLElement) => {
  const targetScrollTop = element.scrollHeight - 1 - element.clientHeight;
  element.scrollTop = Math.max(targetScrollTop, 0);
};

const formatMessageTime = (value: string | undefined) => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

const ConversationScrollMemory = ({ isActive }: { isActive: boolean }) => {
  const { scrollRef, scrollToBottom } = useStickToBottomContext();

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;

      scrollElementToChatBottom(element);
      void scrollToBottom({ animation: "instant", ignoreEscapes: true });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isActive, scrollRef, scrollToBottom]);

  return null;
};

const inferChatTitle = (promptText: string): string => {
  const collapsed = promptText.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "New chat";
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

const getMessageText = (message: UIMessage) =>
  message.parts
    .flatMap((part) => {
      if (!part || typeof part !== "object" || part.type !== "text") {
        return [];
      }

      const value = typeof part.text === "string" ? part.text.trim() : "";
      return value ? [value] : [];
    })
    .join("\n\n");

const MessageHoverFooter = ({ message }: { message: UIMessage }) => {
  const [copied, setCopied] = useState(false);
  const metadata = message.metadata as ChatMessageMetadata | undefined;
  const modelLabel = metadata?.modelLabel;
  const reasoningLabel = metadata?.reasoningLabel;
  const time = formatMessageTime(metadata?.createdAt);
  const text = getMessageText(message);
  const footerText = [modelLabel, reasoningLabel, time]
    .filter(Boolean)
    .join(" · ");
  const positionClassName =
    message.role === "user" ? "right-0 justify-end" : "left-0 justify-start";

  const copyMessage = useCallback(async () => {
    if (!text) {
      return;
    }

    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [text]);

  if (!footerText && !text) {
    return null;
  }

  return (
    <div
      className={`${positionClassName} pointer-events-none absolute top-full z-10 mt-1 flex items-center gap-2 text-muted-foreground text-xs opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100`}
    >
      {footerText ? <span>{footerText}</span> : null}
      {text ? (
        <button
          aria-label="Copy message"
          className="pointer-events-auto rounded p-1 transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => void copyMessage()}
          type="button"
        >
          {copied ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </button>
      ) : null}
    </div>
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getNestedString = (
  value: unknown,
  paths: readonly (readonly string[])[],
) => {
  if (!isRecord(value)) {
    return null;
  }

  for (const path of paths) {
    let current: unknown = value;
    for (const segment of path) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[segment];
    }

    if (typeof current === "string" && current.trim().length > 0) {
      return current;
    }
  }

  return null;
};

const getFilePathFromWriteOutputText = (output: unknown) => {
  if (typeof output !== "string") {
    return null;
  }

  const match = output.match(
    /(?:^|\b)(?:the\s+)?file\s+(.+?)\s+(?:has\s+been|was)\s+(?:updated|written|created)\b/i,
  );
  const rawPath = match?.[1]?.trim();
  if (!rawPath) {
    return null;
  }

  return rawPath.replace(/^[`'"]+|[`'".]+$/g, "");
};

const getWritePartFilePath = (part: ChatMessagePart) => {
  const record = part as Record<string, unknown>;
  return (
    getNestedString(record.input, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["filename"],
      ["name"],
      ["file", "path"],
      ["file", "filePath"],
      ["file", "filename"],
      ["file", "name"],
    ]) ??
    getNestedString(record.output, [
      ["filePath"],
      ["path"],
      ["file_path"],
      ["filename"],
      ["name"],
      ["file"],
      ["file", "path"],
      ["file", "filePath"],
      ["file", "filename"],
      ["file", "name"],
    ]) ??
    getFilePathFromWriteOutputText(record.output)
  );
};

const getSavedWriteDiff = (part: ChatMessagePart) =>
  getNestedString((part as Record<string, unknown>).output, [
    ["diff"],
    ["patch"],
    ["changes", "diff"],
    ["file", "diff"],
  ]);

const toRelativeProjectPath = (projectPath: string, filePath: string) => {
  const normalizedProjectPath = projectPath
    .replace(/\\/g, "/")
    .replace(/\/$/, "");
  const normalizedFilePath = filePath.replace(/\\/g, "/");

  if (
    normalizedFilePath
      .toLowerCase()
      .startsWith(`${normalizedProjectPath.toLowerCase()}/`)
  ) {
    return normalizedFilePath.slice(normalizedProjectPath.length + 1);
  }

  return normalizedFilePath;
};

const readResponseText = async (response: Response) => {
  try {
    return await response.text();
  } catch {
    return "Request failed.";
  }
};

const withSavedWriteDiff = (
  output: unknown,
  filePath: string,
  diff: string,
) => {
  if (isRecord(output)) {
    return {
      ...output,
      diff,
      diffFormat: "unified",
      filePath,
    };
  }

  return {
    diff,
    diffFormat: "unified",
    filePath,
    message: typeof output === "string" ? output : undefined,
  };
};

const addSavedWriteDiffToMessages = (
  currentMessages: UIMessage[],
  messageId: string,
  partIndex: number,
  filePath: string,
  diff: string,
) => {
  let changed = false;
  const nextMessages = currentMessages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    const part = message.parts[partIndex];
    if (!part || getSavedWriteDiff(part)) {
      return message;
    }

    changed = true;
    const partRecord = part as Record<string, unknown>;
    const nextParts = [...message.parts];
    nextParts[partIndex] = {
      ...part,
      output: withSavedWriteDiff(partRecord.output, filePath, diff),
    } as ChatMessagePart;

    return { ...message, parts: nextParts };
  });

  return changed ? nextMessages : currentMessages;
};

const addMetadataToMessage = (
  currentMessages: UIMessage[],
  messageId: string,
  metadata: ChatMessageMetadata,
) => {
  let changed = false;
  const nextMessages = currentMessages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    changed = true;
    return {
      ...message,
      metadata: {
        ...metadata,
        ...((message.metadata as Record<string, unknown> | undefined) ?? {}),
      },
    };
  });

  return changed ? nextMessages : currentMessages;
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

type ChatMessageProps = {
  addToolApprovalResponse: ToolApprovalResponder;
  expandToolCalls: boolean;
  isLastMessage: boolean;
  isStreaming: boolean;
  message: UIMessage;
  projectPath: string;
  showReasoningSummaries: boolean;
};

const ChatMessage = memo(
  ({
    addToolApprovalResponse,
    expandToolCalls,
    isLastMessage,
    isStreaming,
    message,
    projectPath,
    showReasoningSummaries,
  }: ChatMessageProps) => {
    if (message.role === "user") {
      return (
        <Message className="relative" from="user">
          <MessageContent>
            <UserMessageContent message={message} />
          </MessageContent>
          <MessageHoverFooter message={message} />
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
      <Message className="relative" from={message.role}>
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
                  className="my-2 flex flex-wrap items-start gap-2"
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
                      return (
                        <RunCommandChip
                          defaultExpanded={expandToolCalls}
                          key={key}
                          part={chipPart_}
                        />
                      );
                    }
                    if (chipToolKind === "agent") {
                      return (
                        <AgentChip
                          defaultExpanded={expandToolCalls}
                          key={key}
                          part={chipPart_}
                        />
                      );
                    }
                    if (chipToolKind === "read") {
                      return (
                        <ReadFileChip
                          defaultExpanded={expandToolCalls}
                          key={key}
                          part={chipPart_}
                        />
                      );
                    }
                    if (chipToolKind === "list") {
                      return (
                        <ListFilesChip
                          defaultExpanded={expandToolCalls}
                          key={key}
                          part={chipPart_}
                          projectPath={projectPath}
                        />
                      );
                    }
                    if (chipToolKind === "write") {
                      return (
                        <WriteFileChip
                          defaultExpanded={expandToolCalls}
                          key={key}
                          onToolApproval={addToolApprovalResponse}
                          part={chipPart_}
                          projectPath={projectPath}
                        />
                      );
                    }
                    if (chipToolKind === "taskOutput") {
                      return (
                        <TaskOutputChip
                          defaultExpanded={expandToolCalls}
                          key={key}
                          part={chipPart_}
                        />
                      );
                    }

                    return (
                      <SearchInFilesChip
                        defaultExpanded={expandToolCalls}
                        key={key}
                        part={chipPart_}
                      />
                    );
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
                    showReasoningSummaries={showReasoningSummaries}
                  />,
                );
              }
            }

            flushChipGroup();
            return elements;
          })()}
        </MessageContent>
        <MessageHoverFooter message={message} />
      </Message>
    );
  },
  (prev: ChatMessageProps, next: ChatMessageProps) =>
    prev.message === next.message &&
    prev.expandToolCalls === next.expandToolCalls &&
    prev.isLastMessage === next.isLastMessage &&
    prev.isStreaming === next.isStreaming &&
    prev.projectPath === next.projectPath &&
    prev.showReasoningSummaries === next.showReasoningSummaries &&
    prev.addToolApprovalResponse === next.addToolApprovalResponse,
);

ChatMessage.displayName = "ChatMessage";

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
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const savedWriteDiffsRef = useRef(new Map<string, string>());
  const loadingWriteDiffsRef = useRef(new Set<string>());
  const failedWriteDiffsRef = useRef(new Set<string>());
  const pendingAssistantMetadataRef = useRef<ChatMessageMetadata | null>(null);
  const conversationContextRef = useRef<StickToBottomContext | null>(null);
  const scrollFrameRef = useRef<number | null>(null);

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
    addToolApprovalResponse,
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

  useEffect(() => {
    setMessagesForChat(chat.id, messages);
  }, [chat.id, messages, setMessagesForChat]);

  // Some provider-backed write tools only return a success string. Capture the
  // live Git diff while it exists and write it back into the chat message so the
  // chip remains inspectable after reloads or later Git operations.
  useEffect(() => {
    const pendingCachedDiffs: Array<{
      diff: string;
      filePath: string;
      messageId: string;
      partIndex: number;
    }> = [];

    for (const message of messages) {
      if (message.role !== "assistant") {
        continue;
      }

      for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
        const part = message.parts[partIndex];
        if (getChipToolKind(part) !== "write" || getSavedWriteDiff(part)) {
          continue;
        }

        const partRecord = part as Record<string, unknown>;
        if (partRecord.state !== "output-available") {
          continue;
        }

        const filePath = getWritePartFilePath(part);
        if (!filePath) {
          continue;
        }

        const cacheKey = `${chat.id}:${message.id}:${partIndex}:${filePath}`;
        const cachedDiff = savedWriteDiffsRef.current.get(cacheKey);
        if (cachedDiff) {
          pendingCachedDiffs.push({
            diff: cachedDiff,
            filePath,
            messageId: message.id,
            partIndex,
          });
          continue;
        }

        if (
          loadingWriteDiffsRef.current.has(cacheKey) ||
          failedWriteDiffsRef.current.has(cacheKey)
        ) {
          continue;
        }

        loadingWriteDiffsRef.current.add(cacheKey);
        void (async () => {
          try {
            const relativeFilePath = toRelativeProjectPath(
              project.path,
              filePath,
            );
            const statusResponse = await fetch("/api/project-git-status", {
              body: JSON.stringify({ projectPath: project.path }),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            });

            if (!statusResponse.ok) {
              throw new Error(await readResponseText(statusResponse));
            }

            const statusPayload = (await statusResponse.json()) as {
              changes?: Array<{
                path: string;
                previousPath: string | null;
                status: string;
              }>;
            };
            const change = statusPayload.changes?.find((entry) => {
              const normalizedEntryPath = entry.path.replace(/\\/g, "/");
              const normalizedPreviousPath = entry.previousPath?.replace(
                /\\/g,
                "/",
              );
              return (
                normalizedEntryPath.toLowerCase() ===
                  relativeFilePath.toLowerCase() ||
                normalizedPreviousPath?.toLowerCase() ===
                  relativeFilePath.toLowerCase()
              );
            });

            if (!change) {
              throw new Error("No Git diff is available for this file.");
            }

            const diffResponse = await fetch("/api/project-git-diff", {
              body: JSON.stringify({
                filePath: change.path,
                previousPath: change.previousPath,
                projectPath: project.path,
                status: change.status,
              }),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            });

            if (!diffResponse.ok) {
              throw new Error(await readResponseText(diffResponse));
            }

            const diffPayload = (await diffResponse.json()) as {
              diff?: string;
            };
            const diff = diffPayload.diff?.trim();
            if (!diff) {
              throw new Error("No Git diff is available for this file.");
            }

            savedWriteDiffsRef.current.set(cacheKey, diff);
            setMessages((currentMessages) =>
              addSavedWriteDiffToMessages(
                currentMessages,
                message.id,
                partIndex,
                filePath,
                diff,
              ),
            );
          } catch {
            failedWriteDiffsRef.current.add(cacheKey);
          } finally {
            loadingWriteDiffsRef.current.delete(cacheKey);
          }
        })();
      }
    }

    if (pendingCachedDiffs.length > 0) {
      setMessages((currentMessages) =>
        pendingCachedDiffs.reduce(
          (nextMessages, { diff, filePath, messageId, partIndex }) =>
            addSavedWriteDiffToMessages(
              nextMessages,
              messageId,
              partIndex,
              filePath,
              diff,
            ),
          currentMessages,
        ),
      );
    }
  }, [chat.id, messages, project.path, setMessages]);

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

  const scheduleConversationScroll = useCallback(
    (mode: "force" | "locked") => {
      if (!isActive || scrollFrameRef.current !== null) {
        return;
      }

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        const conversationContext = conversationContextRef.current;
        const element = conversationContext?.scrollRef.current;
        if (!conversationContext || !element) {
          return;
        }
        if (mode === "locked" && conversationContext.escapedFromLock) {
          return;
        }

        scrollElementToChatBottom(element);
        void conversationContext.scrollToBottom({
          animation: "instant",
          ignoreEscapes: true,
        });
      });
    },
    [isActive],
  );

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, []);

  const scrollConversationToBottom = useCallback(() => {
    if (!isActive) {
      return;
    }

    scheduleConversationScroll("force");
  }, [isActive, scheduleConversationScroll]);

  const scrollConversationToBottomIfLocked = useCallback(() => {
    if (!isActive) {
      return;
    }

    scheduleConversationScroll("locked");
  }, [isActive, scheduleConversationScroll]);

  const handleSubmit = useCallback(
    async (prompt: PromptInputMessage) => {
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

      if (!prompt.text.trim() && prompt.files.length === 0) {
        return;
      }

      if (chatMessages.length === 0) {
        updateChat(chat.id, (current) => ({
          ...current,
          title: inferChatTitle(prompt.text),
        }));
      }

      const submittedChatId = chat.id;
      pendingAssistantMetadataRef.current = {
        model: activeModel,
        modelLabel: activeOption?.label ?? activeModel,
        reasoningEffort: selectedReasoningEffort,
        reasoningLabel: selectedReasoningLabel,
      };
      setPromptText("");
      useIdeStore.getState().setChatStreaming(submittedChatId, true);
      try {
        const sendPromise = sendMessage(
          {
            files: prompt.files,
            metadata: {
              createdAt: new Date().toISOString(),
              model: activeModel,
              modelLabel: activeOption?.label ?? activeModel,
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
      }
    },
    [
      allModelOptions,
      claudePermissionMode,
      codexPermissionMode,
      clearError,
      chatMessages,
      providerModels,
      project.path,
      selectedProvider,
      selectedReasoningEffort,
      selectedReasoningLabel,
      sendMessage,
      scrollConversationToBottom,
      chat,
      updateChat,
    ],
  );

  const isStreaming = status === "streaming";
  const isProcessing = status === "submitted" || status === "streaming";

  const closeRenameDialog = useCallback(() => {
    setRenameTarget(null);
    setRenameValue("");
  }, []);

  const handleRenameChat = useCallback(() => {
    setRenameTarget({ id: chat.id, name: chat.title });
    setRenameValue(chat.title);
  }, [chat.id, chat.title]);

  const handleRenameSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const nextName = renameValue.trim();
      if (!renameTarget || !nextName) {
        return;
      }

      updateChat(renameTarget.id, (current) => ({
        ...current,
        title: nextName,
      }));
      closeRenameDialog();
    },
    [closeRenameDialog, renameTarget, renameValue, updateChat],
  );

  const wasProcessingRef = useRef(isProcessing);

  // Build a fingerprint that changes whenever new data arrives.
  const lastMessage = messages[messages.length - 1];
  const showChatHeader = messages.length > 0;
  const canShowChatMenu = !isDraftChat || messages.length > 0;
  const lastPart = lastMessage?.parts?.[lastMessage.parts.length - 1];
  const streamFingerprint = `${messages.length}:${lastMessage?.parts?.length ?? 0}:${
    lastPart && "text" in lastPart ? (lastPart.text as string).length : 0
  }`;

  useEffect(() => {
    const wasProcessing = wasProcessingRef.current;
    wasProcessingRef.current = isProcessing;

    if (isProcessing && !wasProcessing) {
      scrollConversationToBottom();
      return;
    }

    if (!isProcessing && wasProcessing) {
      scrollConversationToBottomIfLocked();
    }
  }, [
    isProcessing,
    scrollConversationToBottom,
    scrollConversationToBottomIfLocked,
  ]);

  useEffect(() => {
    void streamFingerprint;

    if (!isProcessing) {
      return;
    }

    scrollConversationToBottomIfLocked();
  }, [isProcessing, scrollConversationToBottomIfLocked, streamFingerprint]);

  return (
    <>
      <div id={panelDomId} className="flex h-full min-h-0 flex-col">
        {showChatHeader ? (
          <div className="shrink-0 px-2 pt-2">
            <div className="mx-auto flex w-full max-w-[700px] items-center justify-between gap-3 pb-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-sm">{chat.title}</p>
              </div>

              {canShowChatMenu ? (
                <div className="flex shrink-0 items-center gap-1">
                  <DropdownMenu
                    onOpenChange={setChatMenuOpen}
                    open={chatMenuOpen}
                  >
                    <DropdownMenuTrigger
                      render={
                        <Button
                          aria-label={`${chat.title} actions`}
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
                      <DropdownMenuItem onClick={handleRenameChat}>
                        <FilePenLine className="size-4" />
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => deleteChat(chat.id)}>
                        <Trash2 className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        <Conversation
          contextRef={conversationContextRef}
          id={conversationDomId}
          className="min-h-0 flex-1"
          initial={false}
        >
          <ConversationContent
            id={conversationContentDomId}
            className={`mx-auto w-full max-w-[700px] gap-4 px-0 pt-3${
              messages.length === 0 ? " min-h-full" : ""
            }`}
            style={{ paddingBottom: CHAT_CONTENT_BOTTOM_PADDING_PX }}
          >
            {messages.length === 0 ? (
              <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-4 text-center">
                <img
                  alt=""
                  className="size-16"
                  draggable={false}
                  src="/icon.png"
                />
                <p className="font-medium text-lg">Build anything</p>
              </div>
            ) : (
              messages.map((message, messageIndex) => (
                <ChatMessage
                  addToolApprovalResponse={addToolApprovalResponse}
                  expandToolCalls={settings.expandToolCalls}
                  isLastMessage={messageIndex === messages.length - 1}
                  isStreaming={isStreaming}
                  key={message.id}
                  message={message}
                  projectPath={project.path}
                  showReasoningSummaries={settings.showReasoningSummaries}
                />
              ))
            )}
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

        <div id={promptDomId} className="shrink-0 px-2 pb-2">
          <div className="mx-auto w-full max-w-[700px]">
            <Sparkles
              density={70}
              disabled={!isProcessing}
              height={30}
              sway={0}
              speed={2}
              palette={["#9bf2ff", "#6ac7ff", "#caf8ff", "#5ea3ff"]}
            >
              <div className="overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md">
                {/* ── Prompt Input ──────────────────────────────────────── */}
                <PromptInput
                  id={promptInputDomId}
                  className="w-full [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:backdrop-blur-none [&_[data-slot=input-group]]:ring-0 [&_[data-slot=input-group]]:focus-within:ring-0 [&_[data-slot=input-group]]:focus-within:border-0"
                  onSubmit={handleSubmit}
                >
                  <PromptInputBody>
                    <PromptAttachments />
                    <PromptInputTextarea
                      className="min-h-0 border-none bg-transparent px-3 py-2 shadow-none focus-visible:ring-0"
                      onChange={(event) => setPromptText(event.target.value)}
                      placeholder="Ask anything..."
                      rows={1}
                      value={promptText}
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
                      <PromptInputSubmit
                        className="size-8 rounded-md"
                        disabled={
                          !isProcessing &&
                          (!isProviderInstalled ||
                            selectedModel === "" ||
                            promptText.trim() === "")
                        }
                        onStop={stop}
                        status={status}
                      />
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
                          (option) => option.provider === chat.provider,
                        ) ?? matchingOptions[0];
                      if (!nextOption) return;

                      updateChat(chat.id, (current) => ({
                        ...current,
                        model: nextOption.id,
                        provider: nextOption.provider,
                        remoteConversationId: null,
                        remoteConversationModel: null,
                        remoteConversationProjectPath: null,
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
                      {allModelOptions.map((option) => (
                        <SelectItem
                          className="text-xs"
                          key={`${option.provider}:${option.id}`}
                          value={option.id}
                        >
                          <span className="flex items-center gap-1.5">
                            <ProviderIcon
                              className="size-3.5 shrink-0 text-muted-foreground/70"
                              provider={option.provider}
                            />
                            <span className="truncate">{option.label}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Reasoning effort selector */}
                  {reasoningEffortOptions.length > 0 && (
                    <Select
                      onValueChange={(value) => {
                        updateChat(chat.id, (current) => ({
                          ...current,
                          reasoningEffort: value as ReasoningEffort,
                        }));
                      }}
                      value={selectedReasoningEffort}
                    >
                      <SelectTrigger className="h-7 w-auto gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground">
                        <span className="truncate">
                          {selectedReasoningLabel}
                        </span>
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
                  <div className="ml-auto">
                    <Context
                      maxTokens={contextWindow}
                      modelId={modelId}
                      usedTokens={estimatedUsedTokens}
                    >
                      <ContextTrigger className="h-7 gap-1.5 border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground" />
                      <ContextContent side="top" align="end">
                        <ContextContentHeader />
                        <ContextContentBody className="space-y-1.5">
                          <ContextInputUsage />
                          <ContextOutputUsage />
                          <ContextReasoningUsage />
                          <ContextCacheUsage />
                        </ContextContentBody>
                      </ContextContent>
                    </Context>
                  </div>
                </div>
              </div>
            </Sparkles>
            <div className="mt-1 flex justify-end">
              <BranchSwitcher
                projectId={project.id}
                projectPath={project.path}
              />
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
              <DialogTitle>Rename chat</DialogTitle>
              <DialogDescription>
                Choose a new name for this chat.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder="Enter a name"
              value={renameValue}
            />
            <DialogFooter>
              <Button
                onClick={closeRenameDialog}
                type="button"
                variant="outline"
              >
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
