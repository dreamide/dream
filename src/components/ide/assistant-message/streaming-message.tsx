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

type InlineCodeRange = {
  end: number;
  start: number;
};

type HastNode = {
  children?: HastNode[];
  position?: {
    end?: { offset?: number };
    start?: { offset?: number };
  };
  properties?: Record<string, unknown>;
  tagName?: string;
  type?: string;
  value?: string;
};

const SKIP_DREAM_STREAMING_ANIMATION_TAGS = new Set([
  "annotation",
  "math",
  "pre",
  "svg",
]);

const getHastNodeOffsets = (node: HastNode) => {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;

  return typeof start === "number" && typeof end === "number"
    ? { end, start }
    : null;
};

const getAnimatedTokenCount = (text: string) => text.match(/\S+/g)?.length ?? 0;

export const getMarkdownBlockStartOffsets = (markdownText: string) => {
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

const getInlineCodeRanges = (markdownText: string): InlineCodeRange[] => {
  const ranges: InlineCodeRange[] = [];
  let index = 0;

  while (index < markdownText.length) {
    if (
      markdownText[index] !== "`" ||
      isEscapedMarkdownCharacter(markdownText, index)
    ) {
      index++;
      continue;
    }

    const delimiterLength = getBacktickRunLength(markdownText, index);
    if (
      delimiterLength === 0 ||
      delimiterLength > INLINE_CODE_MAX_DELIMITER_LENGTH
    ) {
      index += Math.max(1, delimiterLength);
      continue;
    }

    const rangeEnd = findClosingInlineCodeDelimiter(
      markdownText.slice(index),
      delimiterLength,
    );
    if (rangeEnd === -1) {
      index += delimiterLength;
      continue;
    }

    ranges.push({
      end: index + rangeEnd,
      start: index,
    });
    index += rangeEnd;
  }

  return ranges;
};

const getSearAnimationStyle = (delayMs: number) =>
  [
    "--sd-animation:sd-searIn",
    `--sd-duration:${STREAMING_TEXT_REVEAL_DURATION_MS}ms`,
    "--sd-easing:cubic-bezier(0.16, 1, 0.3, 1)",
    `--sd-delay:${delayMs}ms`,
  ].join(";");

const appendHastStyle = (node: HastNode, style: string) => {
  node.properties = node.properties ?? {};
  const existingStyle = node.properties.style;
  node.properties.style =
    typeof existingStyle === "string" && existingStyle
      ? `${existingStyle};${style}`
      : style;
};

const splitTextForSearAnimation = (
  value: string,
  nodeStartOffset: number,
  animationStartOffset: number,
  animatedTokenIndex: { current: number },
): HastNode[] => {
  const cutoff = Math.min(
    value.length,
    Math.max(0, animationStartOffset - nodeStartOffset),
  );
  const nodes: HastNode[] = [];
  const stableText = value.slice(0, cutoff);
  const animatedText = value.slice(cutoff);

  if (stableText) {
    nodes.push({ type: "text", value: stableText });
  }

  for (const token of animatedText.match(/\s+|\S+\s*/g) ?? []) {
    if (!/\S/.test(token)) {
      nodes.push({ type: "text", value: token });
      continue;
    }

    nodes.push({
      children: [{ type: "text", value: token }],
      properties: {
        "data-sd-animate": true,
        style: getSearAnimationStyle(
          animatedTokenIndex.current * streamingTextAnimation.stagger,
        ),
      },
      tagName: "span",
      type: "element",
    });
    animatedTokenIndex.current++;
  }

  return nodes;
};

export const createDreamStreamingRehypePlugin =
  (animationStartOffset: number, inlineCodeRanges: InlineCodeRange[]) => () => {
    return (tree: HastNode) => {
      const animatedTokenIndex = { current: 0 };
      let inlineCodeRangeIndex = 0;

      const visit = (node: HastNode, parentTagName: string | null = null) => {
        if (!node.children?.length) {
          return;
        }

        if (
          node.tagName &&
          SKIP_DREAM_STREAMING_ANIMATION_TAGS.has(node.tagName.toLowerCase())
        ) {
          return;
        }

        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index];
          const childTagName = child.tagName?.toLowerCase() ?? null;

          if (childTagName === "code" && parentTagName !== "pre") {
            const offsets =
              inlineCodeRanges[inlineCodeRangeIndex++] ??
              getHastNodeOffsets(child);

            if (offsets && offsets.end > animationStartOffset) {
              child.properties = child.properties ?? {};
              child.properties["data-sd-animate"] = true;
              appendHastStyle(
                child,
                getSearAnimationStyle(
                  animatedTokenIndex.current * streamingTextAnimation.stagger,
                ),
              );
              animatedTokenIndex.current++;
            }
            continue;
          }

          if (child.type === "text" && typeof child.value === "string") {
            const offsets = getHastNodeOffsets(child);
            if (
              !offsets ||
              offsets.end <= animationStartOffset ||
              !child.value.trim()
            ) {
              continue;
            }

            const replacement = splitTextForSearAnimation(
              child.value,
              offsets.start,
              animationStartOffset,
              animatedTokenIndex,
            );
            node.children.splice(index, 1, ...replacement);
            index += replacement.length - 1;
            continue;
          }

          visit(child, childTagName);
        }
      };

      visit(tree);
    };
  };

const InlineCode = ({ className, ...props }: ComponentProps<"code">) => {
  return (
    <code
      className={[INLINE_CODE_CLASS_NAME, className].filter(Boolean).join(" ")}
      data-streamdown="inline-code"
      {...props}
    />
  );
};

export type StreamingMarkdownBlockContextValue = {
  animateStreamedText: boolean;
  markdownAnimationStartOffset: number;
  markdownBlockStartOffsets: readonly number[];
};

export const StreamingMarkdownBlockContext =
  createContext<StreamingMarkdownBlockContextValue | null>(null);

export const StreamingMarkdownBlock = (props: BlockProps) => {
  const animationContext = useContext(StreamingMarkdownBlockContext);
  const inlineCodeRanges = useMemo(
    () => getInlineCodeRanges(props.content),
    [props.content],
  );
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
  const rehypePlugins = useMemo(
    () =>
      animationContext?.animateStreamedText
        ? [
            ...(props.rehypePlugins ?? []),
            createDreamStreamingRehypePlugin(
              blockAnimationStartOffset,
              inlineCodeRanges,
            ),
          ]
        : props.rehypePlugins,
    [
      animationContext?.animateStreamedText,
      blockAnimationStartOffset,
      inlineCodeRanges,
      props.rehypePlugins,
    ],
  );

  return <Block {...props} rehypePlugins={rehypePlugins} />;
};

const MARKDOWN_BLOCK_BOUNDARY_PATTERN =
  /\n(?:([ \t]*\n)|([ \t]*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s+)))/g;
const INLINE_CODE_MAX_DELIMITER_LENGTH = 2;

type StreamingRevealToken = {
  animatedTokenCount: number;
  blocked: boolean;
  forceChunkEnd: boolean;
  kind: "inline-code" | "text" | "whitespace";
  text: string;
};

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

const getBacktickRunLength = (text: string, index: number) => {
  let length = 0;

  while (text[index + length] === "`") {
    length++;
  }

  return length;
};

const isEscapedMarkdownCharacter = (text: string, index: number) => {
  let backslashCount = 0;

  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    backslashCount++;
  }

  return backslashCount % 2 === 1;
};

const findClosingInlineCodeDelimiter = (
  text: string,
  delimiterLength: number,
) => {
  for (
    let index = delimiterLength;
    index < text.length;
    index += Math.max(1, getBacktickRunLength(text, index))
  ) {
    if (text[index] !== "`" || isEscapedMarkdownCharacter(text, index)) {
      continue;
    }

    const runLength = getBacktickRunLength(text, index);
    if (runLength === delimiterLength) {
      return index + runLength;
    }
  }

  return -1;
};

const consumeTrailingWhitespace = (text: string, startIndex: number) => {
  let endIndex = startIndex;

  while (endIndex < text.length && /\s/.test(text[endIndex])) {
    endIndex++;
  }

  return endIndex;
};

const getNextStreamingRevealToken = (
  text: string,
  holdIncompleteInlineCode: boolean,
): StreamingRevealToken => {
  const whitespaceMatch = text.match(/^\s+/);
  if (whitespaceMatch) {
    return {
      animatedTokenCount: 0,
      blocked: false,
      forceChunkEnd: false,
      kind: "whitespace",
      text: whitespaceMatch[0],
    };
  }

  const delimiterLength = getBacktickRunLength(text, 0);
  if (
    delimiterLength > 0 &&
    delimiterLength <= INLINE_CODE_MAX_DELIMITER_LENGTH
  ) {
    const codeEnd = findClosingInlineCodeDelimiter(text, delimiterLength);

    if (codeEnd === -1) {
      return holdIncompleteInlineCode
        ? {
            animatedTokenCount: 0,
            blocked: true,
            forceChunkEnd: false,
            kind: "inline-code",
            text: "",
          }
        : {
            animatedTokenCount: 1,
            blocked: false,
            forceChunkEnd: false,
            kind: "text",
            text: getNextStreamingWordToken(text),
          };
    }

    const tokenEnd = consumeTrailingWhitespace(text, codeEnd);
    return {
      animatedTokenCount: 1,
      blocked: false,
      forceChunkEnd: true,
      kind: "inline-code",
      text: text.slice(0, tokenEnd),
    };
  }

  let tokenEnd = 0;
  while (tokenEnd < text.length && !/\s/.test(text[tokenEnd])) {
    if (
      text[tokenEnd] === "`" &&
      !isEscapedMarkdownCharacter(text, tokenEnd) &&
      getBacktickRunLength(text, tokenEnd) <= INLINE_CODE_MAX_DELIMITER_LENGTH
    ) {
      break;
    }
    tokenEnd++;
  }

  return {
    animatedTokenCount: tokenEnd > 0 ? 1 : 0,
    blocked: false,
    forceChunkEnd: false,
    kind: "text",
    text: tokenEnd > 0 ? text.slice(0, tokenEnd) : text.slice(0, 1),
  };
};

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
  holdIncompleteInlineCode = true,
) => {
  const remainingText = targetText.slice(currentText.length);
  let chunkLength = 0;
  let animatedTokenCount = 0;
  let blocked = false;

  while (chunkLength < remainingText.length && chunkLength < targetChunkSize) {
    const token = getNextStreamingRevealToken(
      remainingText.slice(chunkLength),
      holdIncompleteInlineCode,
    );

    if (token.blocked) {
      blocked = chunkLength === 0;
      break;
    }

    if (!token.text) {
      break;
    }

    if (token.kind === "inline-code" && animatedTokenCount > 0) {
      break;
    }

    if (token.animatedTokenCount > 0) {
      if (animatedTokenCount + token.animatedTokenCount > maxAnimatedTokens) {
        break;
      }
      animatedTokenCount += token.animatedTokenCount;
    }

    chunkLength += token.text.length;

    if (token.forceChunkEnd) {
      break;
    }
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
    blocked,
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
      const { animatedTokenCount, blocked, nextText } = getNextStreamingChunk(
        currentText,
        targetText,
        Math.max(
          1,
          getNextStreamingRevealToken(remainingText, true).text.length,
        ),
        STREAMING_MAX_ANIMATED_TOKENS_PER_TICK,
      );

      return {
        intervalMs: STREAMING_WORD_INTERVAL_MS,
        blocked,
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

    const { animatedTokenCount, blocked, nextText } = getNextStreamingChunk(
      currentText,
      targetText,
      targetChunkSize,
      STREAMING_MAX_ANIMATED_TOKENS_PER_TICK,
    );

    return {
      intervalMs: getStreamingFrameInterval(intervalMs, animatedTokenCount),
      blocked,
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
    false,
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

    const { blocked, intervalMs, nextText } = getNextStreamingFrame(
      currentText,
      targetText,
      isStreamingRef.current,
    );

    if (nextText === currentText) {
      if (blocked) {
        return;
      }

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
      animateStreamedText,
      markdownAnimationStartOffset,
      markdownBlockStartOffsets,
    }),
    [
      animateStreamedText,
      markdownAnimationStartOffset,
      markdownBlockStartOffsets,
    ],
  );
  const markdownComponents = useMemo<
    NonNullable<MessageResponseProps["components"]>
  >(
    () => ({
      a: (props) => <MarkdownFileLink {...props} projectPath={projectPath} />,
      inlineCode: (props) => <InlineCode {...props} />,
    }),
    [projectPath],
  );

  return (
    <StreamingMarkdownBlockContext.Provider
      value={streamingMarkdownBlockContext}
    >
      <MessageResponse
        BlockComponent={StreamingMarkdownBlock}
        components={markdownComponents}
        isAnimating={animateStreamedText}
      >
        {markdownText}
      </MessageResponse>
    </StreamingMarkdownBlockContext.Provider>
  );
};
