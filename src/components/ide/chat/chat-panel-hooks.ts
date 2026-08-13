import type { UIMessage } from "ai";
import type { Dispatch, KeyboardEventHandler, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { scrollElementToChatBottom } from "../chat";
import { mergeChatMessageHistories } from "../chat-message-history";

export const useChatMessageSync = ({
  chatId,
  chatMessages,
  isActive,
  messages,
  persistMessagesForChat,
  setMessages,
}: {
  chatId: string;
  chatMessages: UIMessage[];
  isActive: boolean;
  messages: UIMessage[];
  persistMessagesForChat: (
    chatId: string,
    messages?: UIMessage[],
  ) => Promise<void>;
  setMessages: Dispatch<SetStateAction<UIMessage[]>>;
}) => {
  const messagesRef = useRef(chatMessages);
  const isActiveRef = useRef(isActive);
  const lastFlushedMessagesRef = useRef(chatMessages);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Store changes happen on lazy load and completed turns, not on each stream
  // tick. Merge only when that source changes so streaming does not repeatedly
  // walk and stringify the full transcript.
  useEffect(() => {
    setMessages((currentMessages) => {
      const mergedMessages = mergeChatMessageHistories(
        chatMessages,
        currentMessages,
      );
      if (mergedMessages === chatMessages) {
        lastFlushedMessagesRef.current = chatMessages;
      }
      return mergedMessages;
    });
  }, [chatMessages, setMessages]);

  const flushLatestMessages = useCallback(() => {
    const latestMessages = messagesRef.current;
    if (
      latestMessages.length === 0 ||
      latestMessages === lastFlushedMessagesRef.current
    ) {
      return;
    }

    lastFlushedMessagesRef.current = latestMessages;
    void persistMessagesForChat(chatId, latestMessages);
  }, [chatId, persistMessagesForChat]);

  useEffect(() => {
    const wasActive = isActiveRef.current;
    isActiveRef.current = isActive;
    if (wasActive && !isActive) {
      flushLatestMessages();
    }
  }, [flushLatestMessages, isActive]);

  useEffect(() => {
    const flushActiveChat = () => {
      if (isActiveRef.current) {
        flushLatestMessages();
      }
    };

    window.addEventListener("blur", flushActiveChat);
    window.addEventListener("pagehide", flushActiveChat);
    window.addEventListener("beforeunload", flushActiveChat);

    return () => {
      window.removeEventListener("blur", flushActiveChat);
      window.removeEventListener("pagehide", flushActiveChat);
      window.removeEventListener("beforeunload", flushActiveChat);
    };
  }, [flushLatestMessages]);

  useEffect(() => {
    return () => {
      flushLatestMessages();
    };
  }, [flushLatestMessages]);
};

export const useChatAutoScroll = ({
  isActive,
  isProcessing,
  messages,
}: {
  isActive: boolean;
  isProcessing: boolean;
  messages: UIMessage[];
}) => {
  const conversationContextRef = useRef<StickToBottomContext | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const wasProcessingRef = useRef(isProcessing);

  const scheduleConversationScroll = useCallback(
    (mode: "force" | "locked") => {
      if (!isActive || scrollFrameRef.current !== null) {
        return;
      }

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        const conversationContext = conversationContextRef.current;
        const element = conversationContext?.scrollRef.current;
        if (!conversationContext || !element) {
          return;
        }
        if (mode === "locked" && conversationContext.escapedFromLock) {
          return;
        }

        scrollElementToChatBottom(element);
        void conversationContext.scrollToBottom({
          animation: "instant",
          ignoreEscapes: true,
        });
      });
    },
    [isActive],
  );

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, []);

  const scrollConversationToBottom = useCallback(() => {
    if (!isActive) {
      return;
    }

    scheduleConversationScroll("force");
  }, [isActive, scheduleConversationScroll]);

  const scrollConversationToBottomIfLocked = useCallback(() => {
    if (!isActive) {
      return;
    }

    scheduleConversationScroll("locked");
  }, [isActive, scheduleConversationScroll]);

  const lastMessage = messages[messages.length - 1];
  const lastPart = lastMessage?.parts?.[lastMessage.parts.length - 1];
  const streamFingerprint = `${messages.length}:${lastMessage?.parts?.length ?? 0}:${
    lastPart && "text" in lastPart ? (lastPart.text as string).length : 0
  }`;

  useEffect(() => {
    const wasProcessing = wasProcessingRef.current;
    wasProcessingRef.current = isProcessing;

    if (isProcessing && !wasProcessing) {
      scrollConversationToBottom();
      return;
    }

    if (!isProcessing && wasProcessing) {
      scrollConversationToBottomIfLocked();
    }
  }, [
    isProcessing,
    scrollConversationToBottom,
    scrollConversationToBottomIfLocked,
  ]);

  useEffect(() => {
    void streamFingerprint;

    if (!isProcessing) {
      return;
    }

    scrollConversationToBottomIfLocked();
  }, [isProcessing, scrollConversationToBottomIfLocked, streamFingerprint]);

  return {
    conversationContextRef,
    scrollConversationToBottom,
  };
};

export const usePromptHistoryNavigation = ({
  messages,
  promptText,
  setPromptText,
}: {
  messages: UIMessage[];
  promptText: string;
  setPromptText: Dispatch<SetStateAction<string>>;
}) => {
  const historyIndexRef = useRef(-1);
  const savedDraftRef = useRef("");

  const resetPromptHistory = useCallback(() => {
    historyIndexRef.current = -1;
    savedDraftRef.current = "";
  }, []);

  const handlePromptKeyDown = useCallback<
    KeyboardEventHandler<HTMLTextAreaElement>
  >(
    (event) => {
      const history = messages
        .filter((message) => message.role === "user")
        .map((message) =>
          message.parts
            .filter(
              (part): part is Extract<typeof part, { type: "text" }> =>
                part.type === "text",
            )
            .map((part) => part.text.trim())
            .join("\n\n"),
        )
        .filter((text) => text.length > 0);

      if (event.key === "ArrowUp") {
        const textarea = event.currentTarget;
        if (historyIndexRef.current === -1) {
          if (textarea.selectionStart !== 0 || textarea.selectionEnd !== 0) {
            return;
          }
        }
        if (history.length === 0) {
          return;
        }

        event.preventDefault();

        if (historyIndexRef.current === -1) {
          savedDraftRef.current = promptText;
          historyIndexRef.current = history.length - 1;
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1;
        } else {
          return;
        }

        setPromptText(history[historyIndexRef.current]);
      }

      if (event.key === "ArrowDown") {
        if (historyIndexRef.current === -1) {
          return;
        }

        event.preventDefault();

        if (historyIndexRef.current < history.length - 1) {
          historyIndexRef.current += 1;
          setPromptText(history[historyIndexRef.current]);
        } else {
          historyIndexRef.current = -1;
          setPromptText(savedDraftRef.current);
        }
      }
    },
    [promptText, messages, setPromptText],
  );

  return {
    handlePromptKeyDown,
    resetPromptHistory,
  };
};
