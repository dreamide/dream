import type { UIMessage } from "ai";
import type { Dispatch, KeyboardEventHandler, SetStateAction } from "react";
import { useCallback, useEffect, useRef } from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { scrollElementToChatBottom } from "../chat";
import {
  flushChatSession,
  getChatSession,
  retainChatSession,
} from "./chat-runtime";

const CHAT_AUTO_SCROLL_MIN_INTERVAL_MS = 100;

/**
 * The runtime session behind a chat panel. The panel only watches it: the
 * session keeps streaming and saving after the panel unmounts.
 */
export const useChatSession = ({
  chatId,
  isActive,
}: {
  chatId: string;
  isActive: boolean;
}) => {
  const session = getChatSession(chatId);

  // Releasing saves the latest messages, as does leaving the foreground.
  useEffect(() => retainChatSession(chatId), [chatId]);

  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (wasActive && !isActive) {
      flushChatSession(chatId);
    }
  }, [chatId, isActive]);

  return session.chat;
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
  const scrollTimeoutRef = useRef<number | null>(null);
  const lastScrollTimestampRef = useRef(0);
  const wasProcessingRef = useRef(isProcessing);

  const runConversationScroll = useCallback((mode: "force" | "locked") => {
    if (scrollFrameRef.current !== null) {
      return;
    }

    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      lastScrollTimestampRef.current = performance.now();
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
  }, []);

  const scheduleConversationScroll = useCallback(
    (mode: "force" | "locked") => {
      if (!isActive) {
        return;
      }

      if (mode === "force" && scrollTimeoutRef.current !== null) {
        window.clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = null;
      }

      if (
        scrollFrameRef.current !== null ||
        scrollTimeoutRef.current !== null
      ) {
        return;
      }

      const elapsedMs = performance.now() - lastScrollTimestampRef.current;
      const delayMs =
        mode === "force"
          ? 0
          : Math.max(0, CHAT_AUTO_SCROLL_MIN_INTERVAL_MS - elapsedMs);

      if (delayMs > 0) {
        scrollTimeoutRef.current = window.setTimeout(() => {
          scrollTimeoutRef.current = null;
          runConversationScroll(mode);
        }, delayMs);
        return;
      }

      runConversationScroll(mode);
    },
    [isActive, runConversationScroll],
  );

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      if (scrollTimeoutRef.current !== null) {
        window.clearTimeout(scrollTimeoutRef.current);
        scrollTimeoutRef.current = null;
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
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      if (historyIndexRef.current === -1) {
        if (event.key === "ArrowDown") return;
        const textarea = event.currentTarget;
        if (textarea.selectionStart !== 0 || textarea.selectionEnd !== 0)
          return;
      }

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
