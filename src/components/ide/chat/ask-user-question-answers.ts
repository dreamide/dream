import type { UIMessage } from "ai";
import {
  getToolName,
  isToolLikePart,
  normalizeToolName,
  type ToolLikePart,
} from "../assistant-message-tools";
import type { ToolApprovalResponder } from "./tool-call-groups";

type MessagePart = UIMessage["parts"][number];

const getAskUserQuestionApprovalPayload = (reason?: string) => {
  if (!reason) {
    return null;
  }

  try {
    const parsed = JSON.parse(reason);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("answers" in parsed) ||
      !parsed.answers ||
      typeof parsed.answers !== "object"
    ) {
      return null;
    }

    return parsed as { answers: Record<string, unknown> };
  } catch {
    return null;
  }
};

const getAskUserQuestionApprovalId = (part: MessagePart) => {
  if (!isToolLikePart(part)) {
    return null;
  }

  return (
    part.approval?.id ??
    (typeof part.toolCallId === "string"
      ? `anthropic:${part.toolCallId}`
      : null)
  );
};

const isAskUserQuestionPart = (part: MessagePart): part is ToolLikePart =>
  isToolLikePart(part) &&
  normalizeToolName(getToolName(part)) === "ask-user-question";

const getAskUserQuestionPayloadFromPart = (part: MessagePart) => {
  if (!isAskUserQuestionPart(part)) {
    return null;
  }

  const outputPayload =
    part.output &&
    typeof part.output === "object" &&
    !Array.isArray(part.output)
      ? (part.output as { answers?: unknown })
      : null;

  if (
    outputPayload?.answers &&
    typeof outputPayload.answers === "object" &&
    !Array.isArray(outputPayload.answers)
  ) {
    return { answers: outputPayload.answers as Record<string, unknown> };
  }

  return getAskUserQuestionApprovalPayload(part.approval?.reason);
};

/**
 * Carries answers the user already gave (found in `sourceMessages`) over to
 * `messages`, so a final assistant message from the stream does not reset an
 * answered question back to pending.
 */
export const preserveAskUserQuestionAnswers = (
  messages: UIMessage[],
  sourceMessages: UIMessage[],
) => {
  const answersByApprovalId = new Map<
    string,
    { answers: Record<string, unknown>; reason?: string }
  >();

  for (const message of sourceMessages) {
    for (const part of message.parts) {
      const approvalId = getAskUserQuestionApprovalId(part);
      const payload = getAskUserQuestionPayloadFromPart(part);
      if (approvalId && payload) {
        answersByApprovalId.set(approvalId, {
          ...payload,
          reason: isToolLikePart(part) ? part.approval?.reason : undefined,
        });
      }
    }
  }

  if (answersByApprovalId.size === 0) {
    return messages;
  }

  let changed = false;
  const nextMessages = messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }

    let partsChanged = false;
    const nextParts = message.parts.map((part) => {
      if (!isAskUserQuestionPart(part)) {
        return part;
      }

      const approvalId = getAskUserQuestionApprovalId(part);
      const payload = approvalId ? answersByApprovalId.get(approvalId) : null;
      if (!approvalId || !payload) {
        return part;
      }

      const updatedInput =
        part.input &&
        typeof part.input === "object" &&
        !Array.isArray(part.input)
          ? { ...part.input, answers: payload.answers }
          : part.input;

      changed = true;
      partsChanged = true;
      return {
        ...part,
        approval: {
          ...(part.approval ?? { id: approvalId }),
          approved: true,
          ...(payload.reason ? { reason: payload.reason } : {}),
        },
        input: updatedInput,
        output: { answers: payload.answers },
        state: "output-available",
      } as MessagePart;
    });

    return partsChanged ? { ...message, parts: nextParts } : message;
  });

  return changed ? nextMessages : messages;
};

/** Returns the same reference when `response` answers no question. */
export const addAskUserQuestionAnswerToMessages = (
  messages: UIMessage[],
  response: Parameters<ToolApprovalResponder>[0],
) => {
  if (!response.approved) {
    return messages;
  }

  const approvalPayload = getAskUserQuestionApprovalPayload(response.reason);
  if (!approvalPayload) {
    return messages;
  }

  let changed = false;
  const nextMessages = messages.map((message) => {
    if (message.role !== "assistant") {
      return message;
    }

    let partsChanged = false;
    const nextParts = message.parts.map((part) => {
      if (!isAskUserQuestionPart(part)) {
        return part;
      }

      const approvalId = getAskUserQuestionApprovalId(part);
      if (approvalId !== response.id) {
        return part;
      }

      changed = true;
      partsChanged = true;
      const updatedInput =
        part.input &&
        typeof part.input === "object" &&
        !Array.isArray(part.input)
          ? { ...part.input, ...approvalPayload }
          : part.input;

      return {
        ...part,
        approval: {
          ...(part.approval ?? { id: response.id }),
          approved: true,
          reason: response.reason,
        },
        input: updatedInput,
        output: approvalPayload,
        state: "output-available",
      } as MessagePart;
    });

    return partsChanged ? { ...message, parts: nextParts } : message;
  });

  return changed ? nextMessages : messages;
};
