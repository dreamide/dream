import { useVirtualizer } from "@tanstack/react-virtual";
import type { UIMessage } from "ai";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { ChatMessage, type ToolApprovalResponder } from "./chat-message";

const CHAT_MESSAGE_ESTIMATED_HEIGHT_PX = 180;
const CHAT_MESSAGE_VIRTUAL_OVERSCAN = 8;

export const VirtualizedChatMessages = ({
  addToolApprovalResponse,
  expandToolCalls,
  groupToolCalls,
  isStreaming,
  messages,
  projectPath,
  showReasoningSummaries,
}: {
  addToolApprovalResponse: ToolApprovalResponder;
  expandToolCalls: boolean;
  groupToolCalls: boolean;
  isStreaming: boolean;
  messages: UIMessage[];
  projectPath: string;
  showReasoningSummaries: boolean;
}) => {
  const conversationContext = useStickToBottomContext();
  const rowVirtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: messages.length,
    estimateSize: () => CHAT_MESSAGE_ESTIMATED_HEIGHT_PX,
    getItemKey: (index) => messages[index]?.id ?? index,
    getScrollElement: () => conversationContext.scrollRef.current,
    overscan: CHAT_MESSAGE_VIRTUAL_OVERSCAN,
    useAnimationFrameWithResizeObserver: true,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div
      className="relative w-full"
      style={{ height: rowVirtualizer.getTotalSize() }}
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
            ref={rowVirtualizer.measureElement}
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
