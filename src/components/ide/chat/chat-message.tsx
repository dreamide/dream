import type { UIMessage } from "ai";
import { CheckIcon, CopyIcon, PaperclipIcon } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { usePromptInputAttachments } from "@/components/ai-elements/prompt-input";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import { Badge } from "@/components/ui/badge";
import type { AiProvider } from "@/types/ide";
import {
  AgentChip,
  AssistantMessagePart,
  ListFilesChip,
  ReadFileChip,
  RunCommandChip,
  SearchInFilesChip,
  TaskOutputChip,
  WebFetchChip,
  WriteFileChip,
} from "../assistant-message-part";
import { getChipToolKind, isChipToolPart } from "../assistant-message-tools";

export type RenameTarget = {
  id: string;
  name: string;
};

export const PROVIDER_LABELS: Record<AiProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export const CHAT_STREAM_UPDATE_THROTTLE_MS = 50;

export type ChatMessageMetadata = {
  createdAt?: string;
  model?: string;
  modelLabel?: string;
  reasoningEffort?: string;
  reasoningLabel?: string;
  remoteConversationId?: string;
  remoteConversationModel?: string;
  remoteConversationProjectPath?: string;
};

export const CHAT_CONTENT_BOTTOM_PADDING_PX = 88;

export const scrollElementToChatBottom = (element: HTMLElement) => {
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

const formatRunningDuration = (startedAt: number, now: number) => {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
};

const getMessageCreatedAtTime = (value: string | undefined) => {
  if (!value) {
    return null;
  }

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

export const ConversationScrollMemory = ({
  isActive,
}: {
  isActive: boolean;
}) => {
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

export const inferChatTitle = (promptText: string): string => {
  const collapsed = promptText.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "New chat";
  }

  return collapsed.slice(0, 60);
};

export const PromptAttachments = () => {
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

const MessageHoverFooter = ({
  isRunning = false,
  message,
}: {
  isRunning?: boolean;
  message: UIMessage;
}) => {
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [fallbackStartedAt] = useState(() => Date.now());
  const metadata = message.metadata as ChatMessageMetadata | undefined;
  const modelLabel = metadata?.modelLabel;
  const reasoningLabel = metadata?.reasoningLabel;
  const startedAt =
    getMessageCreatedAtTime(metadata?.createdAt) ?? fallbackStartedAt;
  const time = isRunning
    ? `Running ${formatRunningDuration(startedAt, now)}`
    : formatMessageTime(metadata?.createdAt);
  const text = getMessageText(message);
  const footerText = [modelLabel, reasoningLabel, time]
    .filter(Boolean)
    .join(" · ");
  const positionClassName =
    message.role === "user" ? "right-0 justify-end" : "left-0 justify-start";

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    setNow(Date.now());
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRunning]);

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
      {text && !isRunning ? (
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

export const addMetadataToMessage = (
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

export type ToolApprovalResponder = (response: {
  id: string;
  approved: boolean;
  reason?: string;
  scope?: "once" | "session";
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

export const ChatMessage = memo(
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
        <MessageContent className="w-full gap-3">
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
                  className="my-1.5 flex flex-wrap items-start gap-2"
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
                          onToolApproval={addToolApprovalResponse}
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
                          projectPath={projectPath}
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
                    if (chipToolKind === "toolSearch") {
                      return (
                        <SearchInFilesChip
                          defaultExpanded={expandToolCalls}
                          key={key}
                          part={chipPart_}
                        />
                      );
                    }
                    if (chipToolKind === "webFetch") {
                      return (
                        <WebFetchChip
                          defaultExpanded={expandToolCalls}
                          key={key}
                          onToolApproval={addToolApprovalResponse}
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
                    onToolApproval={addToolApprovalResponse}
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
        <MessageHoverFooter
          isRunning={isStreaming && isLastMessage}
          message={message}
        />
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
