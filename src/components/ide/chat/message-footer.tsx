import type { UIMessage } from "ai";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { ProjectReference } from "@/types/ide";
import { getMessageText } from "./message-content";

export type ChatMessageMetadata = {
  completedAt?: string;
  createdAt?: string;
  model?: string;
  modelLabel?: string;
  modelSpeed?: string;
  modelSpeedLabel?: string;
  projectReferences?: ProjectReference[];
  reasoningEffort?: string;
  reasoningLabel?: string;
  remoteConversationId?: string;
  remoteConversationModel?: string;
  remoteConversationModelSpeed?: string;
  remoteConversationProjectPath?: string;
  startedAt?: string;
};

const parseMessageTime = (value: string | undefined) => {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
};

const formatMessageTime = (value: string | undefined) => {
  const date = parseMessageTime(value);
  if (!date) {
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

const getMessageTimestamp = (value: string | undefined) =>
  parseMessageTime(value)?.getTime() ?? null;

const isClaudeMessageMetadata = (metadata: ChatMessageMetadata | undefined) => {
  const modelLabel = metadata?.modelLabel?.trim().toLowerCase() ?? "";
  const model = metadata?.model?.trim().toLowerCase() ?? "";

  return (
    modelLabel.startsWith("claude") ||
    model.startsWith("claude") ||
    model.startsWith("opus") ||
    model.startsWith("sonnet") ||
    model.startsWith("haiku")
  );
};

export const MessageHoverFooter = ({
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
  const modelSpeedLabel = isClaudeMessageMetadata(metadata)
    ? undefined
    : metadata?.modelSpeedLabel;
  const reasoningLabel = metadata?.reasoningLabel;
  const durationStartedAt =
    getMessageTimestamp(metadata?.startedAt) ??
    getMessageTimestamp(metadata?.createdAt);
  const startedAt =
    durationStartedAt ??
    getMessageTimestamp(metadata?.createdAt) ??
    fallbackStartedAt;
  const completedAt = getMessageTimestamp(metadata?.completedAt);
  const time = isRunning
    ? `Running for ${formatRunningDuration(startedAt, now)}`
    : formatMessageTime(
        message.role === "assistant"
          ? metadata?.completedAt
          : metadata?.createdAt,
      );
  const duration =
    !isRunning && durationStartedAt !== null && completedAt !== null
      ? `Ran for ${formatRunningDuration(durationStartedAt, completedAt)}`
      : null;
  const text = getMessageText(message);
  const footerItems = [
    { text: modelLabel, shimmer: false },
    { text: reasoningLabel, shimmer: false },
    { text: modelSpeedLabel, shimmer: false },
    { text: time, shimmer: isRunning },
    { text: duration, shimmer: false },
  ].filter(
    (item): item is { text: string; shimmer: boolean } => !!item.text,
  );
  const positionClassName =
    message.role === "user"
      ? "ml-auto justify-end text-right"
      : "mr-auto justify-start text-left";

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

  if (footerItems.length === 0 && !text) {
    return null;
  }

  return (
    <div
      className={`${positionClassName} pointer-events-none flex min-h-6 max-w-full items-center gap-2 text-muted-foreground text-xs`}
    >
      {footerItems.length > 0 ? (
        <span>
          {footerItems.map((item, i) => (
            <Fragment key={i}>
              {i > 0 ? " · " : null}
              {item.shimmer ? (
                <Shimmer as="span" duration={2}>
                  {item.text}
                </Shimmer>
              ) : (
                item.text
              )}
            </Fragment>
          ))}
        </span>
      ) : null}
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
