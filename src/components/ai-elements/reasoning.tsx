import { useControllableState } from "@/hooks/use-controllable-state";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentProps, ReactNode } from "react";
import {
  createContext,
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getMarkdownBlockAnimationTokenStartIndices,
  getMarkdownBlockStartOffsets,
  getNextStreamingFrame,
  STREAMING_TEXT_REVEAL_DURATION_MS,
  STREAMING_TEXT_REVEAL_SETTLE_MS,
  StreamingMarkdownBlock,
  StreamingMarkdownBlockContext,
  type StreamingMarkdownBlockContextValue,
} from "@/components/ide/assistant-message/streaming-message";
import { Streamdown } from "streamdown";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  normalizeCodeFenceLanguageMarkers,
  StreamdownCodePre,
} from "@/components/ai-elements/streamdown-code-block";
import { streamdownPlugins } from "@/components/ai-elements/streamdown-plugins";
import { cn } from "@/lib/utils";

import { Shimmer } from "./shimmer";

interface ReasoningContextValue {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
  hasContent: boolean;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  hasContent?: boolean;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;
const reasoningMarkdownComponents = {
  pre: StreamdownCodePre,
} as NonNullable<ComponentProps<typeof Streamdown>["components"]>;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    hasContent = true,
    children,
    ...props
  }: ReasoningProps) => {
    const resolvedDefaultOpen = defaultOpen ?? isStreaming;
    // Track if defaultOpen was explicitly set to false (to prevent auto-open)
    const isExplicitlyClosed = defaultOpen === false;

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: open,
    });
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    });

    const hasEverStreamedRef = useRef(isStreaming);
    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const startTimeRef = useRef<number | null>(null);

    // Track when streaming starts and compute duration
    useEffect(() => {
      if (isStreaming) {
        hasEverStreamedRef.current = true;
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now();
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
        startTimeRef.current = null;
      }
    }, [isStreaming, setDuration]);

    // Auto-open when streaming starts (unless explicitly closed)
    useEffect(() => {
      if (isStreaming && !isOpen && !isExplicitlyClosed) {
        setIsOpen(true);
      }
    }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);

    // Auto-close when streaming ends unless the caller explicitly wants it open.
    useEffect(() => {
      if (
        hasEverStreamedRef.current &&
        !isStreaming &&
        isOpen &&
        !hasAutoClosed &&
        defaultOpen !== true
      ) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed, defaultOpen]);

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        setIsOpen(newOpen);
      },
      [setIsOpen],
    );

    const contextValue = useMemo(
      () => ({ duration, hasContent, isOpen, isStreaming, setIsOpen }),
      [duration, hasContent, isOpen, isStreaming, setIsOpen],
    );

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn("not-prose mb-4", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const aiT = useTranslations("aiElements");
    const { isStreaming, isOpen, duration, hasContent } = useReasoning();
    const thinkingMessage = getThinkingMessage
      ? getThinkingMessage(isStreaming, duration)
      : isStreaming || duration === 0
        ? <Shimmer duration={1}>{aiT("thinking")}</Shimmer>
        : duration === undefined
          ? <span>{aiT("thoughtFewSeconds")}</span>
          : <span>{aiT("thoughtSeconds", { count: duration })}</span>;

    return (
      <CollapsibleTrigger
        className={cn(
          "inline-flex w-fit items-center gap-1.5 rounded-full border border-stone-300 bg-stone-100 px-2.5 py-1 text-stone-700 text-xs transition-colors hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-950",
          className,
        )}
        disabled={!hasContent}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-3.5 shrink-0" />
            {thinkingMessage}
            {hasContent && (
              <ChevronDownIcon
                className={cn(
                  "size-3.5 shrink-0 transition-transform",
                  isOpen ? "rotate-180" : "rotate-0",
                )}
              />
            )}
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => {
    const { dir, ...contentProps } = props;
    const { isStreaming } = useReasoning();
    const visibleChildrenRef = useRef(isStreaming ? "" : children);
    const animationStartOffsetRef = useRef(
      visibleChildrenRef.current.length,
    );
    const revealTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const animationTimeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const [visibleChildren, setVisibleChildren] = useState(
      visibleChildrenRef.current,
    );
    const [animateStreamedText, setAnimateStreamedText] = useState(false);

    // Track whether this component was ever in a streaming state so that
    // already-visible text keeps its animation styles after streaming stops,
    // while historical messages (never streamed) render instantly.
    const hasStreamedRef = useRef(isStreaming);
    if (isStreaming) {
      hasStreamedRef.current = true;
    }

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

    const markdownText = useMemo(
      () => normalizeCodeFenceLanguageMarkers(visibleChildren),
      [visibleChildren],
    );
    const rawMarkdownAnimationStartOffset = animationStartOffsetRef.current;
    const markdownAnimationStartOffset = useMemo(
      () =>
        normalizeCodeFenceLanguageMarkers(
          visibleChildren.slice(0, rawMarkdownAnimationStartOffset),
        ).length,
      [rawMarkdownAnimationStartOffset, visibleChildren],
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

    useEffect(() => {
      if (isStreaming) {
        hasStreamedRef.current = true;
      }

      if (revealTimeoutIdRef.current !== null) {
        clearTimeout(revealTimeoutIdRef.current);
        revealTimeoutIdRef.current = null;
      }

      if (!hasStreamedRef.current) {
        if (visibleChildrenRef.current !== children) {
          animationStartOffsetRef.current = children.length;
          visibleChildrenRef.current = children;
          setVisibleChildren(children);
        }
        setAnimateStreamedText(false);
        return;
      }

      let cancelled = false;

      function scheduleRevealTick(delayMs: number) {
        revealTimeoutIdRef.current = setTimeout(() => {
          revealTimeoutIdRef.current = null;
          runRevealTick();
        }, delayMs);
      }

      function runRevealTick() {
        if (cancelled) {
          return;
        }

        const currentText = visibleChildrenRef.current;

        if (currentText === children) {
          if (!isStreaming) {
            keepTextAnimationActive(true);
          }
          return;
        }

        if (!children.startsWith(currentText)) {
          animationStartOffsetRef.current = children.length;
          visibleChildrenRef.current = children;
          keepTextAnimationActive(true);
          startTransition(() => {
            setVisibleChildren(children);
          });
          return;
        }

        const frame = getNextStreamingFrame(currentText, children, isStreaming);

        if (frame.nextText === currentText) {
          if (!isStreaming) {
            animationStartOffsetRef.current = children.length;
            visibleChildrenRef.current = children;
            keepTextAnimationActive(true);
            startTransition(() => {
              setVisibleChildren(children);
            });
          }
          return;
        }

        animationStartOffsetRef.current = frame.animationStartOffset;
        visibleChildrenRef.current = frame.nextText;
        keepTextAnimationActive(frame.nextText === children);
        startTransition(() => {
          setVisibleChildren(frame.nextText);
        });

        if (frame.nextText !== children) {
          scheduleRevealTick(frame.intervalMs);
        }
      }

      scheduleRevealTick(0);

      return () => {
        cancelled = true;
        if (revealTimeoutIdRef.current !== null) {
          clearTimeout(revealTimeoutIdRef.current);
          revealTimeoutIdRef.current = null;
        }
      };
    }, [children, isStreaming, keepTextAnimationActive]);

    useEffect(
      () => () => {
        if (revealTimeoutIdRef.current !== null) {
          clearTimeout(revealTimeoutIdRef.current);
          revealTimeoutIdRef.current = null;
        }
        if (animationTimeoutIdRef.current !== null) {
          clearTimeout(animationTimeoutIdRef.current);
          animationTimeoutIdRef.current = null;
        }
      },
      [],
    );

    return (
      <CollapsibleContent
        className={cn(
          "dream-markdown-code-size mt-2 border-current border-l pl-3 text-stone-700 text-sm dark:text-stone-300",
          "outline-none",
          className,
        )}
        dir={dir}
        {...contentProps}
      >
        <StreamingMarkdownBlockContext.Provider
          value={streamingMarkdownBlockContext}
        >
          <Streamdown
            BlockComponent={StreamingMarkdownBlock}
            components={reasoningMarkdownComponents}
            isAnimating={animateStreamedText}
            plugins={streamdownPlugins}
          >
            {markdownText}
          </Streamdown>
        </StreamingMarkdownBlockContext.Provider>
      </CollapsibleContent>
    );
  },
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
