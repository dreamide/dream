import { useContext, useMemo } from "react";
import { Block, type BlockProps, parseMarkdownIntoBlocks } from "streamdown";
import {
  dreamStreamingRehypePlugin,
  getMarkdownBlockAnimationTokenStartIndices,
  getMarkdownBlockStartOffsets,
  StreamingMarkdownBlockContext,
  type StreamingMarkdownBlockContextValue,
  setActiveStreamingBlockOptions,
} from "./streaming-message";

type RehypePlugins = NonNullable<BlockProps["rehypePlugins"]>;

// Reuse a single optionless plugin list per base `props.rehypePlugins` so
// Streamdown's unified processor LRU cache hits on every streaming tick.
const EMPTY_STREAMING_PLUGINS: RehypePlugins = [dreamStreamingRehypePlugin];
const streamingPluginsCache = new WeakMap<RehypePlugins, RehypePlugins>();

const getStreamingRehypePlugins = (
  basePlugins: BlockProps["rehypePlugins"],
): RehypePlugins => {
  if (!basePlugins || basePlugins.length === 0) {
    return EMPTY_STREAMING_PLUGINS;
  }
  let cached = streamingPluginsCache.get(basePlugins);
  if (!cached) {
    cached = [...basePlugins, dreamStreamingRehypePlugin];
    streamingPluginsCache.set(basePlugins, cached);
  }
  return cached;
};

type StreamingAnimationLayout = {
  blockStartOffsets: number[];
  blockTokenStartIndices: number[];
};

// Every block of a message reads the same context value, so the whole-message
// layout is computed once per value instead of once per block. A context value
// is never mutated, which keeps this safe under concurrent rendering.
const streamingAnimationLayouts = new WeakMap<
  StreamingMarkdownBlockContextValue,
  StreamingAnimationLayout
>();

const getStreamingAnimationLayout = (
  context: StreamingMarkdownBlockContextValue,
) => {
  const cachedLayout = streamingAnimationLayouts.get(context);
  if (cachedLayout) {
    return cachedLayout;
  }

  const blocks = parseMarkdownIntoBlocks(context.markdownText);
  const layout = {
    blockStartOffsets: getMarkdownBlockStartOffsets(
      context.markdownText,
      blocks,
    ),
    blockTokenStartIndices: getMarkdownBlockAnimationTokenStartIndices(
      context.markdownText,
      context.markdownAnimationStartOffset,
      blocks,
    ),
  };
  streamingAnimationLayouts.set(context, layout);
  return layout;
};

const StreamingMarkdownBlock = (props: BlockProps) => {
  const animationContext = useContext(StreamingMarkdownBlockContext);
  const layout = animationContext?.animateStreamedText
    ? getStreamingAnimationLayout(animationContext)
    : null;
  const blockAnimationStartOffset =
    layout && animationContext
      ? Math.min(
          props.content.length,
          Math.max(
            0,
            animationContext.markdownAnimationStartOffset -
              (layout.blockStartOffsets[props.index] ?? 0),
          ),
        )
      : props.content.length;
  const animationTokenStartIndex =
    layout?.blockTokenStartIndices[props.index] ?? 0;
  // A block with nothing left to reveal keeps Streamdown's own plugin list.
  // Streamdown's Block is memoized on that list's identity, so settled blocks
  // skip the markdown pipeline on every tick and when the animation turns off.
  const animatesBlock = blockAnimationStartOffset < props.content.length;
  const rehypePlugins = useMemo<BlockProps["rehypePlugins"]>(
    () =>
      animatesBlock
        ? getStreamingRehypePlugins(props.rehypePlugins)
        : props.rehypePlugins,
    [animatesBlock, props.rehypePlugins],
  );

  // Set synchronously before `<Block>` runs its markdown pipeline during render.
  setActiveStreamingBlockOptions(
    animatesBlock
      ? {
          animationStartOffset: blockAnimationStartOffset,
          animationTokenStartIndex,
        }
      : null,
  );

  return <Block {...props} rehypePlugins={rehypePlugins} />;
};

export default StreamingMarkdownBlock;
