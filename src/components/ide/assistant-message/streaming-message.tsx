import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MessageResponse,
  type MessageResponseProps,
} from "@/components/ai-elements/message";
import { MarkdownFileLink } from "../chat/markdown-file-link";

export const STREAMING_WORD_INTERVAL_MS = 40;
export const STREAMING_MIN_INTERVAL_MS = 18;
export const STREAMING_BACKLOG_START_CHARS = 120;
export const STREAMING_BACKLOG_FULL_SPEED_CHARS = 900;
export const STREAMING_BACKLOG_TARGET_TICKS = 18;
export const STREAMING_MIN_CHARS_PER_TICK = 24;
export const STREAMING_MAX_CHARS_PER_TICK = 140;
export const STREAMING_FINISHED_INTERVAL_MS = 8;
export const STREAMING_FINISHED_MIN_CHARS_PER_TICK = 240;
export const STREAMING_FINISHED_MAX_CHARS_PER_TICK = 1200;
export const STREAMING_TEXT_FADE_DURATION_MS = 180;
export const STREAMING_TEXT_FADE_SETTLE_MS = 120;

const streamingTextAnimation = {
  animation: "fadeIn",
  duration: STREAMING_TEXT_FADE_DURATION_MS,
  easing: "ease-out",
  sep: "word",
  stagger: 16,
} as const;

export const getNextStreamingWordToken = (text: string) =>
  text.match(/^(\s+|\S+\s*)/)?.[0] ?? text.slice(0, 1);

export const getBacklogPressure = (remainingLength: number) => {
  if (remainingLength <= STREAMING_BACKLOG_START_CHARS) {
    return 0;
  }

  return Math.min(
    1,
    (remainingLength - STREAMING_BACKLOG_START_CHARS) /
      (STREAMING_BACKLOG_FULL_SPEED_CHARS - STREAMING_BACKLOG_START_CHARS),
  );
};

export const getNextStreamingChunkText = (
  currentText: string,
  targetText: string,
  targetChunkSize: number,
) => {
  const remainingText = targetText.slice(currentText.length);
  let chunkLength = 0;

  while (chunkLength < remainingText.length && chunkLength < targetChunkSize) {
    chunkLength += getNextStreamingWordToken(
      remainingText.slice(chunkLength),
    ).length;
  }

  return targetText.slice(0, currentText.length + chunkLength);
};

export const getNextStreamingFrame = (
  currentText: string,
  targetText: string,
  isStreaming: boolean,
) => {
  const remainingText = targetText.slice(currentText.length);

  if (isStreaming) {
    const pressure = getBacklogPressure(remainingText.length);

    if (pressure === 0) {
      return {
        intervalMs: STREAMING_WORD_INTERVAL_MS,
        nextText: currentText + getNextStreamingWordToken(remainingText),
      };
    }

    const targetChunkSize = Math.min(
      STREAMING_MAX_CHARS_PER_TICK,
      Math.max(
        STREAMING_MIN_CHARS_PER_TICK,
        Math.ceil(remainingText.length / STREAMING_BACKLOG_TARGET_TICKS),
      ),
    );
    const intervalMs = Math.round(
      STREAMING_WORD_INTERVAL_MS -
        pressure * (STREAMING_WORD_INTERVAL_MS - STREAMING_MIN_INTERVAL_MS),
    );

    return {
      intervalMs,
      nextText: getNextStreamingChunkText(
        currentText,
        targetText,
        targetChunkSize,
      ),
    };
  }

  const targetChunkSize = Math.min(
    STREAMING_FINISHED_MAX_CHARS_PER_TICK,
    Math.max(
      STREAMING_FINISHED_MIN_CHARS_PER_TICK,
      Math.ceil(remainingText.length / 4),
    ),
  );

  return {
    intervalMs: STREAMING_FINISHED_INTERVAL_MS,
    nextText: getNextStreamingChunkText(
      currentText,
      targetText,
      targetChunkSize,
    ),
  };
};

export const StreamingMessageResponse = ({
  isStreaming,
  projectPath,
  text,
}: {
  isStreaming: boolean;
  projectPath: string;
  text: string;
}) => {
  const hasStreamedRef = useRef(isStreaming);
  const isStreamingRef = useRef(isStreaming);
  const targetTextRef = useRef(text);
  const visibleTextRef = useRef(isStreaming ? "" : text);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animationTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const tickRef = useRef<() => void>(() => {});
  const [visibleText, setVisibleText] = useState(visibleTextRef.current);
  const [animateStreamedText, setAnimateStreamedText] = useState(false);

  const keepTextAnimationActive = useCallback(
    (settleAfterFinalTick: boolean) => {
      if (animationTimeoutIdRef.current !== null) {
        clearTimeout(animationTimeoutIdRef.current);
        animationTimeoutIdRef.current = null;
      }

      setAnimateStreamedText(true);

      if (settleAfterFinalTick) {
        animationTimeoutIdRef.current = setTimeout(() => {
          animationTimeoutIdRef.current = null;
          setAnimateStreamedText(false);
        }, STREAMING_TEXT_FADE_DURATION_MS + STREAMING_TEXT_FADE_SETTLE_MS);
      }
    },
    [],
  );

  const scheduleTick = useCallback((delayMs: number) => {
    if (timeoutIdRef.current !== null) {
      return;
    }

    timeoutIdRef.current = setTimeout(() => {
      timeoutIdRef.current = null;
      tickRef.current();
    }, delayMs);
  }, []);

  tickRef.current = () => {
    const targetText = targetTextRef.current;
    const currentText = visibleTextRef.current;

    if (currentText === targetText) {
      return;
    }

    if (!targetText.startsWith(currentText)) {
      visibleTextRef.current = targetText;
      startTransition(() => {
        setVisibleText(targetText);
      });
      return;
    }

    const { intervalMs, nextText } = getNextStreamingFrame(
      currentText,
      targetText,
      isStreamingRef.current,
    );

    if (nextText === currentText) {
      visibleTextRef.current = targetText;
      startTransition(() => {
        setVisibleText(targetText);
      });
      return;
    }

    visibleTextRef.current = nextText;
    keepTextAnimationActive(nextText === targetText);
    startTransition(() => {
      setVisibleText(nextText);
    });

    if (nextText !== targetText) {
      scheduleTick(intervalMs);
    }
  };

  useEffect(() => {
    targetTextRef.current = text;
    isStreamingRef.current = isStreaming;
    if (isStreaming) {
      hasStreamedRef.current = true;
    }
    if (!hasStreamedRef.current) {
      if (visibleTextRef.current !== text) {
        visibleTextRef.current = text;
        setVisibleText(text);
      }
      return;
    }

    if (visibleTextRef.current !== targetTextRef.current) {
      scheduleTick(
        isStreaming
          ? STREAMING_WORD_INTERVAL_MS
          : STREAMING_FINISHED_INTERVAL_MS,
      );
    }
  }, [isStreaming, scheduleTick, text]);

  useEffect(() => {
    return () => {
      if (timeoutIdRef.current !== null) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
      if (animationTimeoutIdRef.current !== null) {
        clearTimeout(animationTimeoutIdRef.current);
        animationTimeoutIdRef.current = null;
      }
    };
  }, []);

  const markdownComponents = useMemo<
    NonNullable<MessageResponseProps["components"]>
  >(
    () => ({
      a: (props) => <MarkdownFileLink {...props} projectPath={projectPath} />,
    }),
    [projectPath],
  );

  return (
    <MessageResponse
      animated={streamingTextAnimation}
      components={markdownComponents}
      isAnimating={animateStreamedText}
    >
      {visibleText}
    </MessageResponse>
  );
};
