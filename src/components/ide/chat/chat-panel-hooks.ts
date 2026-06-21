import type { UIMessage } from "ai";
import type { Dispatch, KeyboardEventHandler, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { scrollElementToChatBottom } from "../chat";
import { mergeChatMessageHistories } from "../chat-message-history";
import { areMessagesEqual } from "../store";

export const useChatMessageSync = ({
  chatId,
  chatMessages,
  messages,
  setMessages,
  setMessagesForChat,
}: {
  chatId: string;
  chatMessages: UIMessage[];
  messages: UIMessage[];
  setMessages: Dispatch<SetStateAction<UIMessage[]>>;
  setMessagesForChat: (chatId: string, messages: UIMessage[]) => void;
}) => {
  const messagesRef = useRef(chatMessages);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const mergedMessages = mergeChatMessageHistories(chatMessages, messages);
    if (!areMessagesEqual(messages, mergedMessages)) {
      setMessages(mergedMessages);
    }
  }, [chatMessages, messages, setMessages]);

  useEffect(() => {
    setMessagesForChat(chatId, messages);
  }, [chatId, messages, setMessagesForChat]);

  useEffect(() => {
    return () => {
      const latestMessages = messagesRef.current;
      if (latestMessages.length > 0) {
        setMessagesForChat(chatId, latestMessages);
      }
    };
  }, [chatId, setMessagesForChat]);
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
