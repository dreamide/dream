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
export const STREAMING_SMOOTH_REVEAL_BUFFER_MS = 240;
export const STREAMING_SMOOTH_REVEAL_MAX_DELAY_MS = 260;
export const STREAMING_SMOOTH_REVEAL_CHECK_INTERVAL_MS = 24;

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

const MARKDOWN_TABLE_SEPARATOR_ROW_PATTERN =
  /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

const splitMarkdownTableRowCells = (row: string) => {
  const value = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  let inlineCodeDelimiterLength = 0;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];

    if (character === "`" && !isEscapedMarkdownCharacter(value, index)) {
      const delimiterLength = getBacktickRunLength(value, index);
      if (
        delimiterLength > 0 &&
        delimiterLength <= INLINE_CODE_MAX_DELIMITER_LENGTH
      ) {
        if (inlineCodeDelimiterLength === delimiterLength) {
          inlineCodeDelimiterLength = 0;
        } else if (inlineCodeDelimiterLength === 0) {
          inlineCodeDelimiterLength = delimiterLength;
        }
      }
      cell += value.slice(index, index + delimiterLength);
      index += delimiterLength - 1;
      continue;
    }

    if (
      character === "|" &&
      inlineCodeDelimiterLength === 0 &&
      !isEscapedMarkdownCharacter(value, index)
    ) {
      cells.push(cell);
      cell = "";
      continue;
    }

    cell += character;
  }

  cells.push(cell);
  return cells;
};

const getMarkdownTextAnimatedTokenCount = (text: string) => {
  const inlineCodeRanges = getInlineCodeRanges(text);
  if (inlineCodeRanges.length === 0) {
    return getAnimatedTokenCount(text);
  }

  let cursor = 0;
  let tokenCount = 0;
  for (const range of inlineCodeRanges) {
    tokenCount += getAnimatedTokenCount(text.slice(cursor, range.start));
    tokenCount++;
    cursor = range.end;
  }

  tokenCount += getAnimatedTokenCount(text.slice(cursor));
  return tokenCount;
};

const getMarkdownTableAnimatedTokenCount = (markdownText: string) => {
  const lines = markdownText
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());

  if (
    lines.length < 2 ||
    !MARKDOWN_TABLE_SEPARATOR_ROW_PATTERN.test(lines[1] ?? "")
  ) {
    return null;
  }

  return lines.reduce((tokenCount, line, index) => {
    if (index === 1) {
      return tokenCount;
    }

    return (
      tokenCount +
      splitMarkdownTableRowCells(line).reduce(
        (cellTokenCount, cell) =>
          cellTokenCount + getMarkdownTextAnimatedTokenCount(cell),
        0,
      )
    );
  }, 0);
};

const getMarkdownAnimatedTokenCount = (markdownText: string) =>
  getMarkdownTableAnimatedTokenCount(markdownText) ??
  getMarkdownTextAnimatedTokenCount(markdownText);

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

export const getMarkdownBlockAnimationTokenStartIndices = (
  markdownText: string,
  animationStartOffset: number,
) => {
  const blocks = parseMarkdownIntoBlocks(markdownText);
  let searchOffset = 0;
  let animatedTokenCount = 0;

  return blocks.map((block) => {
    const blockStartOffset = markdownText.indexOf(block, searchOffset);
    const resolvedBlockStartOffset =
      blockStartOffset === -1 ? searchOffset : blockStartOffset;
    const blockAnimationStartOffset = Math.min(
      block.length,
      Math.max(0, animationStartOffset - resolvedBlockStartOffset),
    );
    const blockAnimationTokenStartIndex = animatedTokenCount;

    if (blockAnimationStartOffset < block.length) {
      animatedTokenCount += getMarkdownAnimatedTokenCount(
        block.slice(blockAnimationStartOffset),
      );
    }

    searchOffset = resolvedBlockStartOffset + block.length;
    return blockAnimationTokenStartIndex;
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

const getListItemRevealAnimationStyle = (delayMs: number) =>
  [
    "--sd-animation:sd-listItemReveal",
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

const markNewListItemForRevealAnimation = (
  listItemNode: HastNode | null,
  animationStartOffset: number,
  delayMs: number,
) => {
  if (!listItemNode) {
    return;
  }

  const offsets = getHastNodeOffsets(listItemNode);
  if (!offsets || offsets.start < animationStartOffset) {
    return;
  }

  listItemNode.properties = listItemNode.properties ?? {};
  if (listItemNode.properties["data-dream-streaming-list-item-animate"]) {
    return;
  }

  listItemNode.properties["data-dream-streaming-list-item-animate"] = true;
  listItemNode.properties["data-sd-animate"] = true;
  appendHastStyle(listItemNode, getListItemRevealAnimationStyle(delayMs));
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
  (
    animationStartOffset: number,
    inlineCodeRanges: InlineCodeRange[],
    animationTokenStartIndex: number,
  ) =>
  () => {
    return (tree: HastNode) => {
      const animatedTokenIndex = { current: animationTokenStartIndex };
      let inlineCodeRangeIndex = 0;

      const visit = (
        node: HastNode,
        parentTagName: string | null = null,
        listItemNode: HastNode | null = null,
      ) => {
        if (!node.children?.length) {
          return;
        }

        if (
          node.tagName &&
          SKIP_DREAM_STREAMING_ANIMATION_TAGS.has(node.tagName.toLowerCase())
        ) {
          return;
        }

        const currentListItemNode =
          node.tagName?.toLowerCase() === "li" ? node : listItemNode;

        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index];
          const childTagName = child.tagName?.toLowerCase() ?? null;

          if (childTagName === "code" && parentTagName !== "pre") {
            const offsets =
              inlineCodeRanges[inlineCodeRangeIndex++] ??
              getHastNodeOffsets(child);

            if (offsets && offsets.end > animationStartOffset) {
              const delayMs =
                animatedTokenIndex.current * streamingTextAnimation.stagger;
              markNewListItemForRevealAnimation(
                currentListItemNode,
                animationStartOffset,
                delayMs,
              );
              child.properties = child.properties ?? {};
              child.properties["data-sd-animate"] = true;
              appendHastStyle(child, getSearAnimationStyle(delayMs));
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

            const firstAnimatedTokenIndex = animatedTokenIndex.current;
            const replacement = splitTextForSearAnimation(
              child.value,
              offsets.start,
              animationStartOffset,
              animatedTokenIndex,
            );
            if (animatedTokenIndex.current > firstAnimatedTokenIndex) {
              markNewListItemForRevealAnimation(
                currentListItemNode,
                animationStartOffset,
                firstAnimatedTokenIndex * streamingTextAnimation.stagger,
              );
            }
            node.children.splice(index, 1, ...replacement);
            index += replacement.length - 1;
            continue;
          }

          visit(child, childTagName, currentListItemNode);
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
  markdownBlockAnimationTokenStartIndices: readonly number[];
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
  const animationTokenStartIndex =
    animationContext?.markdownBlockAnimationTokenStartIndices[props.index] ?? 0;
  const rehypePlugins = useMemo(
    () =>
      animationContext?.animateStreamedText
        ? [
            ...(props.rehypePlugins ?? []),
            createDreamStreamingRehypePlugin(
              blockAnimationStartOffset,
              inlineCodeRanges,
              animationTokenStartIndex,
            ),
          ]
        : props.rehypePlugins,
    [
      animationContext?.animateStreamedText,
      animationTokenStartIndex,
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

type StreamingFrame = {
  animatedTokenCount: number;
  animationStartOffset: number;
  blocked?: boolean;
  intervalMs: number;
  nextText: string;
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

export const getStreamingTailAnimationStartOffset = ({
  currentText,
  holdIncompleteInlineCode = true,
  maxAnimatedTokens,
  nextText,
}: {
  currentText: string;
  holdIncompleteInlineCode?: boolean;
  maxAnimatedTokens: number;
  nextText: string;
}) => {
  if (
    maxAnimatedTokens === Number.POSITIVE_INFINITY ||
    maxAnimatedTokens <= 0 ||
    !nextText.startsWith(currentText)
  ) {
    return currentText.length;
  }

  const revealedText = nextText.slice(currentText.length);
  const animatedTokenOffsets: number[] = [];
  let cursor = 0;

  while (cursor < revealedText.length) {
    const token = getNextStreamingRevealToken(
      revealedText.slice(cursor),
      holdIncompleteInlineCode,
    );

    if (token.blocked || !token.text) {
      break;
    }

    if (token.animatedTokenCount > 0) {
      animatedTokenOffsets.push(cursor);
    }

    cursor += token.text.length;
  }

  if (animatedTokenOffsets.length <= maxAnimatedTokens) {
    return currentText.length;
  }

  return (
    currentText.length +
    animatedTokenOffsets[animatedTokenOffsets.length - maxAnimatedTokens]
  );
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
  let blocked = false;
  let endsAtMarkdownBlockBoundary = false;

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

    chunkLength += token.text.length;
  }

  const boundaryCutoff = getMarkdownBlockBoundaryCutoff(
    remainingText,
    chunkLength,
  );
  if (boundaryCutoff !== null) {
    chunkLength = boundaryCutoff;
    endsAtMarkdownBlockBoundary = true;
  }
  const nextText = targetText.slice(0, currentText.length + chunkLength);
  const animationStartOffset = getStreamingTailAnimationStartOffset({
    currentText,
    holdIncompleteInlineCode,
    maxAnimatedTokens,
    nextText,
  });
  const animatedTokenCount = Math.min(
    maxAnimatedTokens,
    getMarkdownAnimatedTokenCount(nextText.slice(animationStartOffset)),
  );

  return {
    animationStartOffset,
    animatedTokenCount,
    blocked,
    endsAtMarkdownBlockBoundary,
    nextText,
  };
};

const getStreamingFrameInterval = (
  baseIntervalMs: number,
  animatedTokenCount: number,
  waitForAnimationEnd = true,
) => {
  const staggerIntervalMs =
    animatedTokenCount <= 1
      ? baseIntervalMs
      : Math.max(
          baseIntervalMs,
          animatedTokenCount * streamingTextAnimation.stagger,
        );

  if (!waitForAnimationEnd || animatedTokenCount === 0) {
    return staggerIntervalMs;
  }

  if (animatedTokenCount <= 1) {
    return Math.max(baseIntervalMs, STREAMING_TEXT_REVEAL_DURATION_MS);
  }

  return Math.max(
    staggerIntervalMs,
    (animatedTokenCount - 1) * streamingTextAnimation.stagger +
      STREAMING_TEXT_REVEAL_DURATION_MS,
  );
};

const getStreamingRevealBufferTokenCount = (
  text: string,
  maxTokenCount: number,
) => {
  let cursor = 0;
  let tokenCount = 0;

  while (cursor < text.length && tokenCount < maxTokenCount) {
    const token = getNextStreamingRevealToken(text.slice(cursor), true);

    if (token.blocked || !token.text) {
      break;
    }

    cursor += token.text.length;
    tokenCount += token.animatedTokenCount;
  }

  return tokenCount;
};

export const getNextStreamingFrame = (
  currentText: string,
  targetText: string,
  isStreaming: boolean,
): StreamingFrame => {
  const remainingText = targetText.slice(currentText.length);

  if (isStreaming) {
    const pressure = getBacklogPressure(remainingText.length);

    if (pressure === 0) {
      const { animationStartOffset, animatedTokenCount, blocked, nextText } =
        getNextStreamingChunk(
          currentText,
          targetText,
          STREAMING_MIN_CHARS_PER_TICK,
          STREAMING_MAX_ANIMATED_TOKENS_PER_TICK,
        );

      return {
        intervalMs: getStreamingFrameInterval(
          STREAMING_WORD_INTERVAL_MS,
          animatedTokenCount,
        ),
        animationStartOffset,
        blocked,
        nextText,
        animatedTokenCount,
      };
    }

    const targetChunkSize = Math.min(
      STREAMING_FINISHED_MAX_CHARS_PER_TICK,
      Math.max(
        STREAMING_MAX_CHARS_PER_TICK,
        Math.ceil(remainingText.length / 4),
      ),
    );
    const intervalMs = Math.round(
      STREAMING_WORD_INTERVAL_MS -
        pressure * (STREAMING_WORD_INTERVAL_MS - STREAMING_MIN_INTERVAL_MS),
    );

    const { animationStartOffset, animatedTokenCount, blocked, nextText } =
      getNextStreamingChunk(
        currentText,
        targetText,
        targetChunkSize,
        STREAMING_MAX_ANIMATED_TOKENS_PER_TICK,
      );

    return {
      intervalMs: getStreamingFrameInterval(intervalMs, animatedTokenCount),
      animationStartOffset,
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

  const { animationStartOffset, animatedTokenCount, nextText } =
    getNextStreamingChunk(
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
    animationStartOffset,
    nextText,
    animatedTokenCount,
  };
};

// While streaming, keep a small unread tail so the reveal loop does not catch
// the network stream and pause between tiny provider chunks.
export const getStreamingRevealDelayMs = ({
  currentText,
  isStreaming,
  pendingElapsedMs,
  targetText,
}: {
  currentText: string;
  isStreaming: boolean;
  pendingElapsedMs: number;
  targetText: string;
}) => {
  if (
    !isStreaming ||
    currentText === targetText ||
    !targetText.startsWith(currentText) ||
    pendingElapsedMs >= STREAMING_SMOOTH_REVEAL_MAX_DELAY_MS
  ) {
    return 0;
  }

  const frame = getNextStreamingFrame(currentText, targetText, true);
  if (frame.blocked || frame.nextText === currentText) {
    return 0;
  }

  const bufferAfterNextFrame = targetText.slice(frame.nextText.length);
  if (getBacklogPressure(bufferAfterNextFrame.length) > 0) {
    return 0;
  }

  const targetBufferTokenCount = Math.max(
    1,
    Math.ceil(STREAMING_SMOOTH_REVEAL_BUFFER_MS / STREAMING_WORD_INTERVAL_MS),
  );
  const bufferedTokenCount = getStreamingRevealBufferTokenCount(
    bufferAfterNextFrame,
    targetBufferTokenCount,
  );

  if (bufferedTokenCount >= targetBufferTokenCount) {
    return 0;
  }

  return Math.min(
    STREAMING_SMOOTH_REVEAL_CHECK_INTERVAL_MS,
    Math.max(0, STREAMING_SMOOTH_REVEAL_MAX_DELAY_MS - pendingElapsedMs),
  );
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
  const visibleTextRef = useRef(isStreaming ? "" : text);
  const animationStartOffsetRef = useRef(0);
  const animationTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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

  useEffect(() => {
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

    if (visibleTextRef.current !== text) {
      const currentText = visibleTextRef.current;
      animationStartOffsetRef.current = text.startsWith(currentText)
        ? getStreamingTailAnimationStartOffset({
            currentText,
            holdIncompleteInlineCode: isStreaming,
            maxAnimatedTokens: isStreaming
              ? STREAMING_MAX_ANIMATED_TOKENS_PER_TICK
              : STREAMING_FINISHED_MAX_ANIMATED_TOKENS_PER_TICK,
            nextText: text,
          })
        : text.length;
      visibleTextRef.current = text;
      keepTextAnimationActive(true);
      startTransition(() => {
        setVisibleText(text);
      });
    }
  }, [isStreaming, keepTextAnimationActive, text]);

  useEffect(() => {
    return () => {
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
  const markdownBlockAnimationTokenStartIndices = useMemo(
    () =>
      getMarkdownBlockAnimationTokenStartIndices(
        markdownText,
        markdownAnimationStartOffset,
      ),
    [markdownAnimationStartOffset, markdownText],
  );
  const streamingMarkdownBlockContext: StreamingMarkdownBlockContextValue = {
    animateStreamedText,
    markdownAnimationStartOffset,
    markdownBlockAnimationTokenStartIndices,
    markdownBlockStartOffsets,
  };
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
