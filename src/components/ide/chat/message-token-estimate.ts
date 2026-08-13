import type { UIMessage } from "ai";
import { estimateTokenCount } from "@/lib/models";

const stringifyEstimatedValue = (value: unknown) => {
  if (value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const estimateValue = (value: unknown) => {
  const estimatedValue = stringifyEstimatedValue(value);
  return estimatedValue ? estimateTokenCount(estimatedValue) : 0;
};

const estimatePart = (part: Record<string, unknown>) => {
  if (
    (part.type === "text" || part.type === "reasoning") &&
    typeof part.text === "string"
  ) {
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
    return (
      estimateValue(part.input) +
      estimateValue(part.output) +
      estimateValue(part.errorText)
    );
  }

  return estimateValue(part);
};

type CachedMessageEstimate = {
  estimate: number;
  lastPart: UIMessage["parts"][number] | undefined;
  lastPartTextLength: number;
  parts: UIMessage["parts"];
};

const messageEstimateCache = new WeakMap<UIMessage, CachedMessageEstimate>();

const getPartTextLength = (part: UIMessage["parts"][number] | undefined) =>
  part && "text" in part && typeof part.text === "string"
    ? part.text.length
    : -1;

const calculateMessageEstimate = (message: UIMessage) => {
  let estimate = 0;
  for (const part of message.parts as Record<string, unknown>[]) {
    estimate += estimatePart(part);
  }
  return estimate;
};

export const estimateMessage = (message: UIMessage) => {
  const lastPart = message.parts.at(-1);
  const lastPartTextLength = getPartTextLength(lastPart);
  const cached = messageEstimateCache.get(message);

  if (
    cached?.parts === message.parts &&
    cached.lastPart === lastPart &&
    cached.lastPartTextLength === lastPartTextLength
  ) {
    return cached.estimate;
  }

  const estimate = calculateMessageEstimate(message);

  messageEstimateCache.set(message, {
    estimate,
    lastPart,
    lastPartTextLength,
    parts: message.parts,
  });
  return estimate;
};

export const estimateMessages = (messages: UIMessage[]) => {
  let total = 0;

  for (let index = 0; index < messages.length; index++) {
    // The final message is the only one AI SDK mutates during a stream. Keep
    // it uncached so in-place tool state/output updates cannot leave a stale
    // context estimate; every completed historical message remains cached.
    total +=
      index === messages.length - 1
        ? calculateMessageEstimate(messages[index])
        : estimateMessage(messages[index]);
  }

  return total;
};
