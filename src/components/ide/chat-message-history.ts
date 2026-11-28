import type { UIMessage } from "ai";
import { preserveAskUserQuestionAnswers } from "./chat/ask-user-question-answers";

const partTextLengthCache = new WeakMap<UIMessage["parts"][number], number>();
const messageScoreCache = new WeakMap<UIMessage, number>();

const getPartTextLength = (part: UIMessage["parts"][number]) => {
  const cached = partTextLengthCache.get(part);
  if (cached !== undefined) {
    return cached;
  }

  let length = 0;
  if ("text" in part && typeof part.text === "string") {
    length = part.text.length;
  } else if ("output" in part && part.output !== undefined) {
    length = JSON.stringify(part.output).length;
  } else if ("input" in part && part.input !== undefined) {
    length = JSON.stringify(part.input).length;
  }

  partTextLengthCache.set(part, length);
  return length;
};

const getMessageScore = (message: UIMessage) => {
  const cached = messageScoreCache.get(message);
  if (cached !== undefined) {
    return cached;
  }
  const score = message.parts.reduce(
    (total, part) => total + 1 + getPartTextLength(part),
    0,
  );
  messageScoreCache.set(message, score);
  return score;
};

const getMessageText = (message: UIMessage) =>
  message.parts
    .flatMap((part) =>
      "text" in part && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();

const isSameMessageIdentity = (left: UIMessage, right: UIMessage) =>
  left.id === right.id && left.role === right.role;

const isDuplicateUserMessage = (
  previous: UIMessage | undefined,
  next: UIMessage,
) =>
  previous?.role === "user" &&
  next.role === "user" &&
  getMessageText(previous) === getMessageText(next);

const canReplaceMessage = (previous: UIMessage, next: UIMessage) => {
  if (previous === next) {
    return true;
  }

  if (isSameMessageIdentity(previous, next)) {
    return getMessageScore(next) >= getMessageScore(previous);
  }

  if (previous.role !== next.role) {
    return false;
  }

  return getMessageScore(next) >= getMessageScore(previous);
};

const canAcceptNextHistory = (
  previousMessages: UIMessage[],
  nextMessages: UIMessage[],
) => {
  if (nextMessages.length < previousMessages.length) {
    return false;
  }

  if (
    nextMessages.some((message, index) =>
      isDuplicateUserMessage(nextMessages[index - 1], message),
    )
  ) {
    return false;
  }

  return previousMessages.every((previousMessage, index) => {
    const nextMessage = nextMessages[index];
    return nextMessage
      ? canReplaceMessage(previousMessage, nextMessage)
      : false;
  });
};

const mergeMessageHistoriesByContent = (
  previousMessages: UIMessage[] | undefined,
  nextMessages: UIMessage[],
) => {
  if (!previousMessages || previousMessages.length === 0) {
    return nextMessages;
  }

  if (nextMessages.length === 0) {
    return previousMessages;
  }

  if (canAcceptNextHistory(previousMessages, nextMessages)) {
    return nextMessages;
  }

  let changed = false;
  const mergedMessages = [...previousMessages];
  const indexById = new Map<string, number>();
  for (let i = 0; i < mergedMessages.length; i += 1) {
    const id = mergedMessages[i].id;
    if (!indexById.has(id)) {
      indexById.set(id, i);
    }
  }

  for (let index = 0; index < nextMessages.length; index++) {
    const nextMessage = nextMessages[index];
    const existingIndex = indexById.get(nextMessage.id) ?? -1;

    if (existingIndex !== -1) {
      const previousMessage = mergedMessages[existingIndex];
      if (canReplaceMessage(previousMessage, nextMessage)) {
        mergedMessages[existingIndex] = nextMessage;
        changed = changed || previousMessage !== nextMessage;
      }
      continue;
    }

    const previousMessage = mergedMessages[index];
    if (!previousMessage) {
      if (isDuplicateUserMessage(mergedMessages.at(-1), nextMessage)) {
        continue;
      }

      indexById.set(nextMessage.id, mergedMessages.length);
      mergedMessages.push(nextMessage);
      changed = true;
      continue;
    }

    if (canReplaceMessage(previousMessage, nextMessage)) {
      if (indexById.get(previousMessage.id) === index) {
        indexById.delete(previousMessage.id);
      }
      mergedMessages[index] = nextMessage;
      if (!indexById.has(nextMessage.id)) {
        indexById.set(nextMessage.id, index);
      }
      changed = changed || previousMessage !== nextMessage;
    }
  }

  return changed ? mergedMessages : previousMessages;
};

export const mergeChatMessageHistories = (
  previousMessages: UIMessage[] | undefined,
  nextMessages: UIMessage[],
) => {
  const mergedMessages = mergeMessageHistoriesByContent(
    previousMessages,
    nextMessages,
  );

  // An answer can be shorter than the original question input. Preserve it
  // whichever history wins the content-length comparison, including when a
  // stale stream snapshot arrives after the answer has already been saved.
  return preserveAskUserQuestionAnswers(mergedMessages, [
    ...(previousMessages ?? []),
    ...nextMessages,
  ]);
};
