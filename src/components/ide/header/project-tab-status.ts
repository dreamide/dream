import type { UIMessage } from "ai";
import {
  getToolName,
  isToolLikePart,
  normalizeToolName,
} from "../assistant-message-tools";

const COMPLETED_ASK_USER_QUESTION_STATES = new Set([
  "approval-responded",
  "output-available",
  "output-denied",
  "output-error",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasAskUserQuestionPrompt = (input: unknown) =>
  isRecord(input) &&
  Array.isArray(input.questions) &&
  input.questions.some(
    (question) =>
      isRecord(question) &&
      typeof question.question === "string" &&
      question.question.trim().length > 0 &&
      Array.isArray(question.options) &&
      question.options.some(
        (option) => isRecord(option) && typeof option.label === "string",
      ),
  );

const hasAnswerPayload = (value: unknown) =>
  isRecord(value) &&
  isRecord(value.answers) &&
  Object.keys(value.answers).length > 0;

const hasApprovalAnswer = (reason: unknown) => {
  if (typeof reason !== "string" || !reason.trim()) {
    return false;
  }

  try {
    return hasAnswerPayload(JSON.parse(reason));
  } catch {
    return false;
  }
};

const getAskUserQuestionAwaitingState = (
  part: UIMessage["parts"][number],
): boolean | null => {
  if (
    !isToolLikePart(part) ||
    normalizeToolName(getToolName(part)) !== "ask-user-question" ||
    !hasAskUserQuestionPrompt(part.input)
  ) {
    return null;
  }

  const approvalId =
    part.approval?.id ??
    (typeof part.toolCallId === "string" ? part.toolCallId : null);
  if (!approvalId) {
    return null;
  }

  const state = typeof part.state === "string" ? part.state : "input-streaming";
  const hasAnswer =
    part.approval?.approved === true ||
    hasApprovalAnswer(part.approval?.reason) ||
    hasAnswerPayload(part.input) ||
    hasAnswerPayload(part.output);

  return !hasAnswer && !COMPLETED_ASK_USER_QUESTION_STATES.has(state);
};

const isAssistantProgressPart = (part: UIMessage["parts"][number]) => {
  if (part.type === "step-start" || isToolLikePart(part)) {
    return true;
  }

  return (
    "text" in part &&
    typeof part.text === "string" &&
    part.text.trim().length > 0
  );
};

export const chatIsAwaitingAnswer = (messages: UIMessage[]) => {
  let awaitingAnswer = false;

  for (const message of messages) {
    if (message.role === "user") {
      awaitingAnswer = false;
      continue;
    }

    if (message.role !== "assistant") {
      continue;
    }

    for (const part of message.parts) {
      const partAwaitingState = getAskUserQuestionAwaitingState(part);
      if (partAwaitingState !== null) {
        awaitingAnswer = partAwaitingState;
      } else if (awaitingAnswer && isAssistantProgressPart(part)) {
        awaitingAnswer = false;
      }
    }
  }

  return awaitingAnswer;
};
