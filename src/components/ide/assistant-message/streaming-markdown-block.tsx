import { useContext, useMemo } from "react";
import { Block, type BlockProps, parseMarkdownIntoBlocks } from "streamdown";
import {
  dreamStreamingRehypePlugin,
  getMarkdownBlockAnimationTokenStartIndices,
  getMarkdownBlockStartOffsets,
  StreamingMarkdownBlockContext,
} from "./streaming-message";

const StreamingMarkdownBlock = (props: BlockProps) => {
  const animationContext = useContext(StreamingMarkdownBlockContext);
  const markdownBlocks = useMemo(
    () =>
      parseMarkdownIntoBlocks(animationContext?.markdownText ?? props.content),
    [animationContext?.markdownText, props.content],
  );
  const markdownBlockStartOffsets = useMemo(
    () =>
      getMarkdownBlockStartOffsets(
        animationContext?.markdownText ?? props.content,
        markdownBlocks,
      ),
    [animationContext?.markdownText, markdownBlocks, props.content],
  );
  const markdownBlockAnimationTokenStartIndices = useMemo(
    () =>
      getMarkdownBlockAnimationTokenStartIndices(
        animationContext?.markdownText ?? props.content,
        animationContext?.markdownAnimationStartOffset ?? 0,
        markdownBlocks,
      ),
    [
      animationContext?.markdownAnimationStartOffset,
      animationContext?.markdownText,
      markdownBlocks,
      props.content,
    ],
  );
  const blockStartOffset = markdownBlockStartOffsets[props.index] ?? 0;
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
    markdownBlockAnimationTokenStartIndices[props.index] ?? 0;
  const rehypePlugins = useMemo<BlockProps["rehypePlugins"]>(
    () =>
      animationContext?.animateStreamedText
        ? [
            ...(props.rehypePlugins ?? []),
            // The per-block offsets are plugin options on purpose: Streamdown
            // caches processors by plugin name and options, so state captured
            // in a closure would be shared across blocks. See
            // dreamStreamingRehypePlugin.
            [
              dreamStreamingRehypePlugin,
              {
                animationStartOffset: blockAnimationStartOffset,
                animationTokenStartIndex,
              },
            ],
          ]
        : props.rehypePlugins,
    [
      animationContext?.animateStreamedText,
      animationTokenStartIndex,
      blockAnimationStartOffset,
      props.rehypePlugins,
    ],
  );

  return <Block {...props} rehypePlugins={rehypePlugins} />;
};

export default StreamingMarkdownBlock;
