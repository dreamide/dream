import type { UIMessage } from "ai";

const getPartTextLength = (part: UIMessage["parts"][number]) => {
  if ("text" in part && typeof part.text === "string") {
    return part.text.length;
  }

  if ("output" in part && part.output !== undefined) {
    return JSON.stringify(part.output).length;
  }

  if ("input" in part && part.input !== undefined) {
    return JSON.stringify(part.input).length;
  }

  return 0;
};

const getMessageScore = (message: UIMessage) =>
  message.parts.reduce((score, part) => score + 1 + getPartTextLength(part), 0);

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

export const mergeChatMessageHistories = (
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

  for (let index = 0; index < nextMessages.length; index++) {
    const nextMessage = nextMessages[index];
    const existingIndex = mergedMessages.findIndex(
      (message) => message.id === nextMessage.id,
    );

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

      mergedMessages.push(nextMessage);
      changed = true;
      continue;
    }

    if (canReplaceMessage(previousMessage, nextMessage)) {
      mergedMessages[index] = nextMessage;
      changed = changed || previousMessage !== nextMessage;
    }
  }

  return changed ? mergedMessages : previousMessages;
};
