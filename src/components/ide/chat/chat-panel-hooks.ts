import type { UIMessage } from "ai";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { scrollElementToChatBottom } from "../chat";
import {
  flushChatSession,
  getChatSession,
  getChatSessionView,
  retainChatSession,
  subscribeLiveTranscript,
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

/**
 * The live transcript a panel renders: the session's messages (at most once
 * per stream update interval) and its status, re-rendering the panel only
 * while `visible`. A panel out of sight (a hidden column, a project in the
 * background) is not rendered again by a running turn, and reads the
 * session as it is now the moment it is shown.
 */
export const useLiveTranscript = ({
  chatId,
  visible,
}: {
  chatId: string;
  visible: boolean;
}) => {
  const subscribe = useMemo(
    () => subscribeLiveTranscript(chatId, visible),
    [chatId, visible],
  );
  const read = useCallback(() => getChatSessionView(chatId), [chatId]);
  return useSyncExternalStore(subscribe, read);
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
      if (mode === "force" && scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
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
  const latestUserMessageId = messages.findLast(
    (message) => message.role === "user",
  )?.id;
  const previousUserMessageIdRef = useRef(latestUserMessageId);

  useEffect(() => {
    const previousUserMessageId = previousUserMessageIdRef.current;
    previousUserMessageIdRef.current = latestUserMessageId;

    if (latestUserMessageId && latestUserMessageId !== previousUserMessageId) {
      scrollConversationToBottom();
    }
  }, [latestUserMessageId, scrollConversationToBottom]);

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
