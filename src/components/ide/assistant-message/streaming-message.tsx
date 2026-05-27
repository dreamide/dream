import {
  type ComponentProps,
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Block, type BlockProps, parseMarkdownIntoBlocks } from "streamdown";
import {
  MAX_STREAMDOWN_MARKDOWN_CHARS,
  MessageResponse,
  type MessageResponseProps,
} from "@/components/ai-elements/message";
import {
  MarkdownFileLink,
  normalizeProjectFileLinksInMarkdown,
} from "../chat/markdown-file-link";

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
export const STREAMING_TEXT_REVEAL_DURATION_MS = 220;
export const STREAMING_TEXT_REVEAL_SETTLE_MS = 140;
export const STREAMING_MAX_ANIMATED_TOKENS_PER_TICK = 8;
export const STREAMING_FINISHED_MAX_ANIMATED_TOKENS_PER_TICK = 10;

export const streamingTextAnimation = {
  animation: "searIn",
  duration: STREAMING_TEXT_REVEAL_DURATION_MS,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  sep: "word",
  stagger: 16,
} as const;

const INLINE_CODE_CLASS_NAME =
  "rounded bg-muted px-1.5 py-0.5 font-mono text-sm";

type MarkdownBlockAnimationContextValue = {
  animationStartOffset: number;
  markdownText: string;
};

const MarkdownBlockAnimationContext =
  createContext<MarkdownBlockAnimationContextValue | null>(null);

type InlineCodeAnimationStyle = NonNullable<ComponentProps<"code">["style"]> &
  Record<
    "--sd-animation" | "--sd-delay" | "--sd-duration" | "--sd-easing",
    string
  >;

const inlineCodeAnimationStyle: InlineCodeAnimationStyle = {
  "--sd-animation": "sd-searIn",
  "--sd-delay": "0ms",
  "--sd-duration": `${STREAMING_TEXT_REVEAL_DURATION_MS}ms`,
  "--sd-easing": "cubic-bezier(0.16, 1, 0.3, 1)",
};

const getMarkdownNodeOffsets = (node: unknown) => {
  if (!node || typeof node !== "object" || !("position" in node)) {
    return null;
  }

  const position = node.position;
  if (
    !position ||
    typeof position !== "object" ||
    !("start" in position) ||
    !("end" in position)
  ) {
    return null;
  }

  const start = position.start;
  const end = position.end;
  if (
    !start ||
    typeof start !== "object" ||
    !("offset" in start) ||
    !end ||
    typeof end !== "object" ||
    !("offset" in end)
  ) {
    return null;
  }

  return typeof start.offset === "number" && typeof end.offset === "number"
    ? { end: end.offset, start: start.offset }
    : null;
};

const getAnimatedTokenCount = (text: string) => text.match(/\S+/g)?.length ?? 0;

const getMarkdownBlockStartOffsets = (markdownText: string) => {
  const blocks = parseMarkdownIntoBlocks(markdownText);
  let searchOffset = 0;

  return blocks.map((block) => {
    const blockStartOffset = markdownText.indexOf(block, searchOffset);

    if (blockStartOffset === -1) {
      return searchOffset;
    }

    searchOffset = blockStartOffset + block.length;
    return blockStartOffset;
  });
};

const getInlineCodeDelay = (
  animationStartOffset: number,
  markdownText: string,
  nodeStartOffset: number | null,
) => {
  if (nodeStartOffset === null || nodeStartOffset <= animationStartOffset) {
    return 0;
  }

  return (
    getAnimatedTokenCount(
      markdownText.slice(animationStartOffset, nodeStartOffset),
    ) * streamingTextAnimation.stagger
  );
};

const InlineCode = ({
  animate,
  className,
  node,
  style,
  ...props
}: ComponentProps<"code"> & {
  animate: boolean;
  node?: unknown;
}) => {
  const animationContext = useContext(MarkdownBlockAnimationContext);
  const animationStartOffset = animationContext?.animationStartOffset ?? 0;
  const markdownText = animationContext?.markdownText ?? "";
  const nodeOffsets = getMarkdownNodeOffsets(node);
  const shouldAnimate =
    animate && (nodeOffsets === null || nodeOffsets.end > animationStartOffset);
  const delay = getInlineCodeDelay(
    animationStartOffset,
    markdownText,
    nodeOffsets?.start ?? null,
  );
  const animatedStyle = shouldAnimate
    ? ({
        ...inlineCodeAnimationStyle,
        ...style,
        "--sd-delay": `${delay}ms`,
      } as ComponentProps<"code">["style"])
    : style;

  return (
    <code
      className={[INLINE_CODE_CLASS_NAME, className].filter(Boolean).join(" ")}
      data-sd-animate={shouldAnimate ? true : undefined}
      data-streamdown="inline-code"
      style={animatedStyle}
      {...props}
    />
  );
};

type StreamingMarkdownBlockContextValue = {
  markdownAnimationStartOffset: number;
  markdownBlockStartOffsets: readonly number[];
};

const StreamingMarkdownBlockContext =
  createContext<StreamingMarkdownBlockContextValue | null>(null);

const StreamingMarkdownBlock = (props: BlockProps) => {
  const animationContext = useContext(StreamingMarkdownBlockContext);
  const blockStartOffset =
    animationContext?.markdownBlockStartOffsets[props.index] ?? 0;
  const blockAnimationStartOffset = animationContext
    ? Math.min(
        props.content.length,
        Math.max(
          0,
          animationContext.markdownAnimationStartOffset - blockStartOffset,
        ),
      )
    : 0;

  return (
    <MarkdownBlockAnimationContext.Provider
      value={{
        animationStartOffset: blockAnimationStartOffset,
        markdownText: props.content,
      }}
    >
      <Block {...props} />
    </MarkdownBlockAnimationContext.Provider>
  );
};

const MARKDOWN_BLOCK_BOUNDARY_PATTERN =
  /\n(?:([ \t]*\n)|([ \t]*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s+)))/g;

const getMarkdownBlockBoundaryCutoff = (
  text: string,
  maxChunkLength: number,
) => {
  MARKDOWN_BLOCK_BOUNDARY_PATTERN.lastIndex = 0;

  for (;;) {
    const match = MARKDOWN_BLOCK_BOUNDARY_PATTERN.exec(text);
    if (!match) return null;

    const cutoff = match[1] ? match.index + match[0].length : match.index + 1;
    if (cutoff <= 0) continue;
    if (cutoff >= maxChunkLength) return null;

    return cutoff;
  }
};

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
  return getNextStreamingChunk(currentText, targetText, targetChunkSize)
    .nextText;
};

const getNextStreamingChunk = (
  currentText: string,
  targetText: string,
  targetChunkSize: number,
  maxAnimatedTokens = Number.POSITIVE_INFINITY,
) => {
  const remainingText = targetText.slice(currentText.length);
  let chunkLength = 0;
  let animatedTokenCount = 0;

  while (chunkLength < remainingText.length && chunkLength < targetChunkSize) {
    const token = getNextStreamingWordToken(remainingText.slice(chunkLength));
    if (/\S/.test(token)) {
      if (animatedTokenCount >= maxAnimatedTokens) {
        break;
      }
      animatedTokenCount++;
    }
    chunkLength += token.length;
  }

  const boundaryCutoff = getMarkdownBlockBoundaryCutoff(
    remainingText,
    chunkLength,
  );
  if (boundaryCutoff !== null) {
    chunkLength = boundaryCutoff;
    animatedTokenCount = getAnimatedTokenCount(
      remainingText.slice(0, boundaryCutoff),
    );
  }

  return {
    animatedTokenCount,
    nextText: targetText.slice(0, currentText.length + chunkLength),
  };
};

const getStreamingFrameInterval = (
  baseIntervalMs: number,
  animatedTokenCount: number,
) => {
  if (animatedTokenCount <= 1) {
    return baseIntervalMs;
  }

  return Math.max(
    baseIntervalMs,
    animatedTokenCount * streamingTextAnimation.stagger,
  );
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
      const { animatedTokenCount, nextText } = getNextStreamingChunk(
        currentText,
        targetText,
        getNextStreamingWordToken(remainingText).length,
        STREAMING_MAX_ANIMATED_TOKENS_PER_TICK,
      );

      return {
        intervalMs: STREAMING_WORD_INTERVAL_MS,
        nextText,
        animatedTokenCount,
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

    const { animatedTokenCount, nextText } = getNextStreamingChunk(
      currentText,
      targetText,
      targetChunkSize,
      STREAMING_MAX_ANIMATED_TOKENS_PER_TICK,
    );

    return {
      intervalMs: getStreamingFrameInterval(intervalMs, animatedTokenCount),
      nextText,
      animatedTokenCount,
    };
  }

  const targetChunkSize = Math.min(
    STREAMING_FINISHED_MAX_CHARS_PER_TICK,
    Math.max(
      STREAMING_FINISHED_MIN_CHARS_PER_TICK,
      Math.ceil(remainingText.length / 4),
    ),
  );

  const { animatedTokenCount, nextText } = getNextStreamingChunk(
    currentText,
    targetText,
    targetChunkSize,
    STREAMING_FINISHED_MAX_ANIMATED_TOKENS_PER_TICK,
  );

  return {
    intervalMs: getStreamingFrameInterval(
      STREAMING_FINISHED_INTERVAL_MS,
      animatedTokenCount,
    ),
    nextText,
    animatedTokenCount,
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
  const animationStartOffsetRef = useRef(0);
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
        }, STREAMING_TEXT_REVEAL_DURATION_MS + STREAMING_TEXT_REVEAL_SETTLE_MS);
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
      animationStartOffsetRef.current = 0;
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
      animationStartOffsetRef.current = 0;
      visibleTextRef.current = targetText;
      startTransition(() => {
        setVisibleText(targetText);
      });
      return;
    }

    animationStartOffsetRef.current = currentText.length;
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

  const markdownText = useMemo(
    () =>
      visibleText.length > MAX_STREAMDOWN_MARKDOWN_CHARS
        ? visibleText
        : normalizeProjectFileLinksInMarkdown(visibleText, projectPath),
    [projectPath, visibleText],
  );
  const markdownAnimationStartOffset = useMemo(
    () =>
      visibleText.length > MAX_STREAMDOWN_MARKDOWN_CHARS
        ? 0
        : normalizeProjectFileLinksInMarkdown(
            visibleText.slice(0, animationStartOffsetRef.current),
            projectPath,
          ).length,
    [projectPath, visibleText],
  );
  const markdownBlockStartOffsets = useMemo(
    () => getMarkdownBlockStartOffsets(markdownText),
    [markdownText],
  );
  const streamingMarkdownBlockContext = useMemo(
    () => ({
      markdownAnimationStartOffset,
      markdownBlockStartOffsets,
    }),
    [markdownAnimationStartOffset, markdownBlockStartOffsets],
  );
  const markdownComponents = useMemo<
    NonNullable<MessageResponseProps["components"]>
  >(
    () => ({
      a: (props) => <MarkdownFileLink {...props} projectPath={projectPath} />,
      inlineCode: (props) => (
        <InlineCode animate={animateStreamedText} {...props} />
      ),
    }),
    [animateStreamedText, projectPath],
  );

  return (
    <StreamingMarkdownBlockContext.Provider
      value={streamingMarkdownBlockContext}
    >
      <MessageResponse
        animated={hasStreamedRef.current ? streamingTextAnimation : undefined}
        BlockComponent={StreamingMarkdownBlock}
        components={markdownComponents}
        isAnimating={animateStreamedText}
      >
        {markdownText}
      </MessageResponse>
    </StreamingMarkdownBlockContext.Provider>
  );
};
