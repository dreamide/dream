import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  projectMessagesForRequest,
  REQUEST_CONTEXT_MESSAGE_LIMIT,
} from "./request-context";

const message = (index: number): UIMessage =>
  ({
    id: `message-${index}`,
    parts: [{ text: `message ${index}`, type: "text" }],
    role: index % 2 === 0 ? "user" : "assistant",
  }) as UIMessage;

describe("projectMessagesForRequest", () => {
  it("leaves a bounded transcript unchanged", () => {
    const messages = [message(0), message(1)];
    expect(projectMessagesForRequest(messages)).toBe(messages);
  });

  it("keeps the newest messages without mutating the visible transcript", () => {
    const messages = Array.from(
      { length: REQUEST_CONTEXT_MESSAGE_LIMIT + 6 },
      (_, index) => message(index),
    );

    const projected = projectMessagesForRequest(messages);

    expect(messages).toHaveLength(REQUEST_CONTEXT_MESSAGE_LIMIT + 6);
    expect(projected).toHaveLength(REQUEST_CONTEXT_MESSAGE_LIMIT + 1);
    expect(projected[0].metadata).toMatchObject({
      omittedMessageCount: 6,
      requestContextCheckpoint: true,
    });
    expect(projected.at(-1)?.id).toBe(messages.at(-1)?.id);
  });
});
