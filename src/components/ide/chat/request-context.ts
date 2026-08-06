import type { UIMessage } from "ai";
import { estimateMessages } from "./message-token-estimate";

export const REQUEST_CONTEXT_TOKEN_BUDGET = 50_000;
export const REQUEST_CONTEXT_MESSAGE_LIMIT = 24;

const createOmissionMarker = (omittedMessageCount: number): UIMessage =>
  ({
    id: "request-context-omission",
    metadata: {
      omittedMessageCount,
      requestContextCheckpoint: true,
    },
    parts: [
      {
        text: `[${omittedMessageCount} earlier messages remain available in Dream's visible chat history but are omitted from this portable recovery context. Continue from the provider's native session history when available.]`,
        type: "text",
      },
    ],
    role: "assistant",
  }) as UIMessage;

export const projectMessagesForRequest = (
  messages: UIMessage[],
): UIMessage[] => {
  if (
    messages.length <= REQUEST_CONTEXT_MESSAGE_LIMIT &&
    estimateMessages(messages) <= REQUEST_CONTEXT_TOKEN_BUDGET
  ) {
    return messages;
  }

  const selected: UIMessage[] = [];
  let selectedTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageTokens = estimateMessages([message]);
    const exceedsMessageLimit =
      selected.length >= REQUEST_CONTEXT_MESSAGE_LIMIT;
    const exceedsTokenBudget =
      selected.length > 0 &&
      selectedTokens + messageTokens > REQUEST_CONTEXT_TOKEN_BUDGET;

    if (exceedsMessageLimit || exceedsTokenBudget) {
      break;
    }

    selected.unshift(message);
    selectedTokens += messageTokens;
  }

  const omittedMessageCount = messages.length - selected.length;
  return omittedMessageCount > 0
    ? [createOmissionMarker(omittedMessageCount), ...selected]
    : selected;
};
