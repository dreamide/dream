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
    return JSON.stringify(value, null, 2);
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

export const estimateMessages = (messages: UIMessage[]) => {
  let total = 0;

  for (const message of messages) {
    for (const part of message.parts as Record<string, unknown>[]) {
      total += estimatePart(part);
    }
  }

  return total;
};
