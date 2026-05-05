import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import type { UIMessage } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
  ChatMessage,
  scrollElementToChatBottom,
  type ToolApprovalResponder,
} from "./chat-message";

const CHAT_MESSAGE_ESTIMATED_HEIGHT_PX = 180;
const CHAT_MESSAGE_VIRTUAL_OVERSCAN = 8;

export const VirtualizedChatMessages = ({
  addToolApprovalResponse,
  expandToolCalls,
  groupToolCalls,
  isActive,
  isStreaming,
  messages,
  projectPath,
  showReasoningSummaries,
}: {
  addToolApprovalResponse: ToolApprovalResponder;
  expandToolCalls: boolean;
  groupToolCalls: boolean;
  isActive: boolean;
  isStreaming: boolean;
  messages: UIMessage[];
  projectPath: string;
  showReasoningSummaries: boolean;
}) => {
  const conversationContext = useStickToBottomContext();
  const [isInitialMeasurementReady, setIsInitialMeasurementReady] =
    useState(false);
  const isInitialMeasurementReadyRef = useRef(isInitialMeasurementReady);
  const measuredInitialIndexesRef = useRef(new Set<number>());
  const measurementFrameRef = useRef<number | null>(null);
  const virtualItemsRef = useRef<VirtualItem[]>([]);
  const rowVirtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: messages.length,
    estimateSize: () => CHAT_MESSAGE_ESTIMATED_HEIGHT_PX,
    getItemKey: (index) => messages[index]?.id ?? index,
    getScrollElement: () => conversationContext.scrollRef.current,
    overscan: CHAT_MESSAGE_VIRTUAL_OVERSCAN,
    useAnimationFrameWithResizeObserver: true,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  virtualItemsRef.current = virtualItems;

  useEffect(() => {
    isInitialMeasurementReadyRef.current = isInitialMeasurementReady;
  }, [isInitialMeasurementReady]);

  useEffect(() => {
    return () => {
      if (measurementFrameRef.current !== null) {
        window.cancelAnimationFrame(measurementFrameRef.current);
        measurementFrameRef.current = null;
      }
    };
  }, []);

  const scheduleInitialMeasurementReadyCheck = useCallback(() => {
    if (
      !isActive ||
      isInitialMeasurementReadyRef.current ||
      measurementFrameRef.current !== null
    ) {
      return;
    }

    measurementFrameRef.current = window.requestAnimationFrame(() => {
      measurementFrameRef.current = null;

      if (!isActive || isInitialMeasurementReadyRef.current) {
        return;
      }

      const visibleItems = virtualItemsRef.current;
      if (visibleItems.length === 0) {
        return;
      }

      const allVisibleItemsMeasured = visibleItems.every((item) =>
        measuredInitialIndexesRef.current.has(item.index),
      );
      if (!allVisibleItemsMeasured) {
        return;
      }

      isInitialMeasurementReadyRef.current = true;
      setIsInitialMeasurementReady(true);

      const element = conversationContext.scrollRef.current;
      if (!element) {
        return;
      }

      scrollElementToChatBottom(element);
      void conversationContext.scrollToBottom({
        animation: "instant",
        ignoreEscapes: true,
      });
    });
  }, [conversationContext, isActive]);

  const measureMessageElement = useCallback(
    (node: HTMLDivElement | null, index: number) => {
      if (!node) {
        return;
      }

      rowVirtualizer.measureElement(node);

      if (!isActive || isInitialMeasurementReadyRef.current) {
        return;
      }

      measuredInitialIndexesRef.current.add(index);
      scheduleInitialMeasurementReadyCheck();
    },
    [isActive, rowVirtualizer, scheduleInitialMeasurementReadyCheck],
  );

  const hideUntilMeasured =
    isActive && messages.length > 0 && !isInitialMeasurementReady;

  return (
    <div
      aria-busy={hideUntilMeasured || undefined}
      className="relative w-full"
      style={{
        height: rowVirtualizer.getTotalSize(),
        visibility: hideUntilMeasured ? "hidden" : undefined,
      }}
    >
      {virtualItems.map((virtualItem) => {
        const message = messages[virtualItem.index];
        if (!message) {
          return null;
        }

        return (
          <div
            className="absolute left-0 top-0 w-full pb-4"
            data-index={virtualItem.index}
            key={virtualItem.key}
            ref={(node) => measureMessageElement(node, virtualItem.index)}
            style={{ transform: `translateY(${virtualItem.start}px)` }}
          >
            <ChatMessage
              addToolApprovalResponse={addToolApprovalResponse}
              expandToolCalls={expandToolCalls}
              groupToolCalls={groupToolCalls}
              isLastMessage={virtualItem.index === messages.length - 1}
              isStreaming={isStreaming}
              message={message}
              projectPath={projectPath}
              showReasoningSummaries={showReasoningSummaries}
            />
          </div>
        );
      })}
    </div>
  );
};
