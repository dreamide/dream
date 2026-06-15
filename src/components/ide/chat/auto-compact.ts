import type { UIMessage } from "ai";
import { estimateTokenCount } from "@/lib/models";

export const AUTO_COMPACT_TRIGGER_RATIO = 0.72;
const AUTO_COMPACT_TARGET_RATIO = 0.45;
const MIN_MESSAGES_TO_COMPACT = 8;
const MIN_RECENT_MESSAGES_TO_KEEP = 4;
const DEFAULT_RECENT_MESSAGES_TO_KEEP = 6;
const MAX_SUMMARY_CHARS = 12_000;
const MAX_MESSAGE_SUMMARY_CHARS = 1_200;
const MAX_TOOL_VALUE_CHARS = 500;

type AutoCompactionResult =
  | {
      compacted: false;
      messages: UIMessage[];
    }
  | {
      compacted: true;
      compactedCount: number;
      messages: UIMessage[];
    };

const truncateText = (value: string, maxChars: number) => {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  const headLength = Math.max(0, Math.floor(maxChars * 0.7));
  const tailLength = Math.max(0, maxChars - headLength - 20);
  return `${trimmed.slice(0, headLength).trimEnd()}\n...[truncated]...\n${trimmed.slice(-tailLength).trimStart()}`;
};

const stringifyCompactValue = (value: unknown) => {
  if (value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return truncateText(value, MAX_TOOL_VALUE_CHARS);
  }

  try {
    return truncateText(JSON.stringify(value), MAX_TOOL_VALUE_CHARS);
  } catch {
    return truncateText(String(value), MAX_TOOL_VALUE_CHARS);
  }
};

const stringifyEstimatedValue = (value: unknown) => {
  if (value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const estimateValue = (value: unknown) => {
  const estimatedValue = stringifyEstimatedValue(value);
  return estimatedValue ? estimateTokenCount(estimatedValue) : 0;
};

const getToolPartName = (part: Record<string, unknown>) => {
  if (typeof part.toolName === "string" && part.toolName.trim()) {
    return part.toolName.trim();
  }

  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    return part.type.slice(5) || "tool";
  }

  return "tool";
};

const summarizeMessage = (message: UIMessage, index: number) => {
  const lines: string[] = [];

  for (const part of message.parts as Record<string, unknown>[]) {
    if (part.type === "text" && typeof part.text === "string") {
      const text = truncateText(part.text, MAX_MESSAGE_SUMMARY_CHARS);
      if (text) {
        lines.push(text);
      }
      continue;
    }

    if (part.type === "reasoning" && typeof part.text === "string") {
      const text = truncateText(part.text, 400);
      if (text) {
        lines.push(`[reasoning summary]\n${text}`);
      }
      continue;
    }

    if (
      typeof part.type === "string" &&
      (part.type.startsWith("tool-") || part.type === "dynamic-tool")
    ) {
      const toolName = getToolPartName(part);
      const input = stringifyCompactValue(part.input);
      const output = stringifyCompactValue(part.output);
      const error =
        typeof part.errorText === "string" && part.errorText.trim()
          ? truncateText(part.errorText, MAX_TOOL_VALUE_CHARS)
          : null;

      lines.push(
        [
          `[tool ${toolName}]`,
          input ? `input: ${input}` : null,
          output ? `output: ${output}` : null,
          error ? `error: ${error}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  }

  const content = lines.join("\n\n").trim();
  if (!content) {
    return null;
  }

  return `### ${index + 1}. ${message.role.toUpperCase()}\n${content}`;
};

const hasPendingApproval = (message: UIMessage) =>
  (message.parts as Record<string, unknown>[]).some((part) => {
    if (
      typeof part.type !== "string" ||
      !(part.type.startsWith("tool-") || part.type === "dynamic-tool")
    ) {
      return false;
    }

    const approval = part.approval;
    return (
      part.state === "approval-requested" &&
      approval !== null &&
      typeof approval === "object" &&
      !("approved" in approval)
    );
  });

const createCompactionSummaryMessage = ({
  compactedMessages,
  originalMessageCount,
}: {
  compactedMessages: UIMessage[];
  originalMessageCount: number;
}): UIMessage => {
  const summarized = compactedMessages
    .map(summarizeMessage)
    .filter((value): value is string => value !== null);
  const compactedAt = new Date().toISOString();
  const body = truncateText(
    [
      "Auto-compacted context summary.",
      "",
      `Compacted ${compactedMessages.length} of ${originalMessageCount} earlier messages at ${compactedAt}.`,
      "Use this summary as prior conversation memory. Recent messages after this summary remain verbatim.",
      "",
      summarized.join("\n\n"),
    ].join("\n"),
    MAX_SUMMARY_CHARS,
  );

  return {
    id:
      typeof globalThis.crypto?.randomUUID === "function"
        ? `auto-compact-${globalThis.crypto.randomUUID()}`
        : `auto-compact-${Date.now()}`,
    metadata: {
      autoCompacted: true,
      compactedAt,
      compactedMessageCount: compactedMessages.length,
    },
    parts: [{ text: body, type: "text" }],
    role: "assistant",
  } as UIMessage;
};

const estimatePart = (part: Record<string, unknown>) => {
  if (part.type === "text" && typeof part.text === "string") {
    return estimateTokenCount(part.text);
  }

  if (part.type === "reasoning" && typeof part.text === "string") {
    return estimateTokenCount(part.text);
  }

  if (part.type === "file") {
    return (
      estimateValue(part.filename) +
      estimateValue(part.mediaType) +
      estimateValue(part.url)
    );
  }

  if (
    typeof part.type === "string" &&
    (part.type.startsWith("tool-") || part.type === "dynamic-tool")
  ) {
    let total = 0;
    if (part.input !== undefined) {
      total += estimateValue(part.input);
    }
    if (part.output !== undefined) {
      total += estimateValue(part.output);
    }
    if (typeof part.errorText === "string") {
      total += estimateTokenCount(part.errorText);
    }
    return total;
  }

  return estimateValue(part);
};

export const estimateMessages = (messages: UIMessage[]) => {
  let total = 0;

  for (const message of messages) {
    for (const part of message.parts as Record<string, unknown>[]) {
      total += estimatePart(part);
    }
  }

  return total;
};

export const maybeAutoCompactMessages = ({
  contextWindow,
  messages,
  usedTokens,
}: {
  contextWindow: number;
  messages: UIMessage[];
  usedTokens: number;
}): AutoCompactionResult => {
  if (
    contextWindow <= 0 ||
    messages.length < MIN_MESSAGES_TO_COMPACT ||
    usedTokens / contextWindow < AUTO_COMPACT_TRIGGER_RATIO
  ) {
    return { compacted: false, messages };
  }

  const pendingApprovalIndex = messages.findIndex(hasPendingApproval);
  let keepCount = DEFAULT_RECENT_MESSAGES_TO_KEEP;
  let compactEndIndex =
    pendingApprovalIndex >= 0
      ? Math.min(messages.length - keepCount, pendingApprovalIndex)
      : messages.length - keepCount;

  if (compactEndIndex < 2) {
    return { compacted: false, messages };
  }

  let nextMessages: UIMessage[] = messages;
  const targetTokens = contextWindow * AUTO_COMPACT_TARGET_RATIO;

  while (keepCount >= MIN_RECENT_MESSAGES_TO_KEEP) {
    const compactedMessages = messages.slice(0, compactEndIndex);
    const summaryMessage = createCompactionSummaryMessage({
      compactedMessages,
      originalMessageCount: messages.length,
    });
    nextMessages = [summaryMessage, ...messages.slice(compactEndIndex)];

    if (estimateMessages(nextMessages) <= targetTokens) {
      break;
    }

    keepCount -= 1;
    compactEndIndex =
      pendingApprovalIndex >= 0
        ? Math.min(messages.length - keepCount, pendingApprovalIndex)
        : messages.length - keepCount;
  }

  if (nextMessages.length >= messages.length) {
    return { compacted: false, messages };
  }

  return {
    compacted: true,
    compactedCount: messages.length - nextMessages.length + 1,
    messages: nextMessages,
  };
};

export const hasAutoCompactionSummary = (messages: UIMessage[]) =>
  messages.some(
    (message) =>
      message.metadata &&
      typeof message.metadata === "object" &&
      (message.metadata as { autoCompacted?: unknown }).autoCompacted === true,
  );
