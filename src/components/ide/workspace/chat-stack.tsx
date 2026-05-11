import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { ChatPanel } from "../chat-panel";
import {
  CHAT_PANEL_MIN_HEIGHT_PX,
  CHAT_PANEL_MIN_WIDTH_PX,
  WORKSPACE_VIEWPORT_BACKGROUND,
} from "./constants";

const CHAT_DRAG_THRESHOLD = 4;
const CHAT_DRAG_FLIP_DURATION_MS = 180;

type ChatColumnMetric = {
  id: string;
  left: number;
  width: number;
};

type ChatDragState = {
  chatId: string;
  currentIndex: number;
  currentX: number;
  initialIndex: number;
  metrics: ChatColumnMetric[];
  moved: boolean;
  pointerId: number;
  startX: number;
};

export interface WorkspaceChatStackProps {
  active: boolean;
  activeChatId: string | null;
  chatColumnWidths: Record<string, number>;
  mountedChats: ChatConfig[];
  onActivateChat: (chatId: string) => void;
  onChatColumnWidthsChange: (widths: Record<string, number>) => void;
  onCloseChat: (chatId: string) => void;
  onChatReorder: (fromIndex: number, toIndex: number) => void;
  openChatIds: string[];
  project: ProjectConfig;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const resolveChatDragDistance = (state: ChatDragState) => {
  const initialMetric = state.metrics[state.initialIndex];
  const firstMetric = state.metrics[0];
  const lastMetric = state.metrics.at(-1);
  if (!initialMetric || !firstMetric || !lastMetric) {
    return 0;
  }

  return clamp(
    state.currentX - state.startX,
    firstMetric.left - initialMetric.left,
    lastMetric.left +
      lastMetric.width -
      initialMetric.left -
      initialMetric.width,
  );
};

const resolveChatDragIndex = (state: ChatDragState) => {
  const initialMetric = state.metrics[state.initialIndex];
  if (!initialMetric) {
    return state.initialIndex;
  }

  const dragDistance = resolveChatDragDistance(state);

  if (dragDistance > 0) {
    const draggedRight =
      initialMetric.left + initialMetric.width + dragDistance;
    let nextIndex = state.initialIndex;

    for (
      let index = state.initialIndex + 1;
      index < state.metrics.length;
      index += 1
    ) {
      const metric = state.metrics[index];
      if (!metric || draggedRight < metric.left + metric.width / 2) {
        break;
      }

      nextIndex = index;
    }

    return nextIndex;
  }

  if (dragDistance < 0) {
    const draggedLeft = initialMetric.left + dragDistance;
    let nextIndex = state.initialIndex;

    for (let index = state.initialIndex - 1; index >= 0; index -= 1) {
      const metric = state.metrics[index];
      if (!metric || draggedLeft > metric.left + metric.width / 2) {
        break;
      }

      nextIndex = index;
    }

    return nextIndex;
  }

  return state.initialIndex;
};

const resolveChatOffset = (
  state: ChatDragState,
  chatId: string,
  chatIndex: number,
) => {
  if (!state.moved) {
    return 0;
  }

  if (chatId === state.chatId) {
    return resolveChatDragDistance(state);
  }

  const draggedMetric = state.metrics[state.initialIndex];
  const draggedWidth = draggedMetric?.width ?? 0;

  if (
    state.initialIndex < state.currentIndex &&
    chatIndex > state.initialIndex &&
    chatIndex <= state.currentIndex
  ) {
    return -draggedWidth;
  }

  if (
    state.initialIndex > state.currentIndex &&
    chatIndex >= state.currentIndex &&
    chatIndex < state.initialIndex
  ) {
    return draggedWidth;
  }

  return 0;
};

const getDragAffectedChatIds = (state: ChatDragState) => {
  const startIndex = Math.min(state.initialIndex, state.currentIndex);
  const endIndex = Math.max(state.initialIndex, state.currentIndex);

  return state.metrics.slice(startIndex, endIndex + 1).map((item) => item.id);
};

const WorkspaceChatStackImpl = ({
  active,
  activeChatId,
  chatColumnWidths,
  mountedChats,
  onActivateChat,
  onChatColumnWidthsChange,
  onCloseChat,
  onChatReorder,
  openChatIds,
  project,
}: WorkspaceChatStackProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const dragChatRef = useRef<ChatDragState | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const settlingCleanupTimeoutRef = useRef<number | null>(null);
  const widthRef = useRef(chatColumnWidths);
  const pendingResizeFrameRef = useRef<number | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const [dragChat, setDragChat] = useState<ChatDragState | null>(null);
  const [settlingChatIds, setSettlingChatIds] = useState<string[]>([]);
  const activeResizeRef = useRef<{
    leftChatId: string;
    leftWidth: number;
    rightChatId: string;
    rightWidth: number;
  } | null>(null);
  const mountedChatsById = useMemo(
    () => new Map(mountedChats.map((chat) => [chat.id, chat])),
    [mountedChats],
  );
  const visibleChats = useMemo(
    () =>
      openChatIds
        .map((chatId) => mountedChatsById.get(chatId))
        .filter((chat): chat is ChatConfig => Boolean(chat)),
    [mountedChatsById, openChatIds],
  );
  const visibleChatIds = useMemo(
    () => new Set(visibleChats.map((chat) => chat.id)),
    [visibleChats],
  );
  const hiddenMountedChats = mountedChats.filter(
    (chat) => !visibleChatIds.has(chat.id),
  );

  useEffect(() => {
    widthRef.current = chatColumnWidths;
  }, [chatColumnWidths]);

  useEffect(
    () => () => {
      if (pendingResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingResizeFrameRef.current);
      }
      dragCleanupRef.current?.();
      resizeCleanupRef.current?.();
      if (settlingCleanupTimeoutRef.current !== null) {
        window.clearTimeout(settlingCleanupTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (settlingChatIds.length === 0) {
      return;
    }

    if (settlingCleanupTimeoutRef.current !== null) {
      window.clearTimeout(settlingCleanupTimeoutRef.current);
    }

    settlingCleanupTimeoutRef.current = window.setTimeout(() => {
      setSettlingChatIds([]);
      settlingCleanupTimeoutRef.current = null;
    }, CHAT_DRAG_FLIP_DURATION_MS);
  }, [settlingChatIds.length]);

  useLayoutEffect(() => {
    const activeResize = activeResizeRef.current;
    if (!activeResize) {
      return;
    }

    applyColumnWidths(
      activeResize.leftChatId,
      activeResize.leftWidth,
      activeResize.rightChatId,
      activeResize.rightWidth,
    );
  });

  const getFallbackWidth = () => {
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    const visibleCount = Math.max(visibleChats.length, 1);
    return Math.max(CHAT_PANEL_MIN_WIDTH_PX, containerWidth / visibleCount);
  };

  const getColumnWidth = (chatId: string) =>
    chatColumnWidths[chatId] ?? getFallbackWidth();

  const applyColumnWidths = (
    leftChatId: string,
    leftWidth: number,
    rightChatId: string,
    rightWidth: number,
  ) => {
    const leftColumn = columnRefs.current[leftChatId];
    const rightColumn = columnRefs.current[rightChatId];

    if (leftColumn) {
      leftColumn.style.flex = `1 1 ${leftWidth}px`;
    }

    if (rightColumn) {
      rightColumn.style.flex = `1 1 ${rightWidth}px`;
    }
  };

  const scheduleColumnWidthApply = (
    leftChatId: string,
    leftWidth: number,
    rightChatId: string,
    rightWidth: number,
  ) => {
    activeResizeRef.current = {
      leftChatId,
      leftWidth,
      rightChatId,
      rightWidth,
    };

    if (pendingResizeFrameRef.current !== null) {
      return;
    }

    pendingResizeFrameRef.current = window.requestAnimationFrame(() => {
      pendingResizeFrameRef.current = null;

      const activeResize = activeResizeRef.current;
      if (!activeResize) {
        return;
      }

      applyColumnWidths(
        activeResize.leftChatId,
        activeResize.leftWidth,
        activeResize.rightChatId,
        activeResize.rightWidth,
      );
    });
  };

  const handleResizeDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (visibleChats.length < 2) {
        return;
      }

      resizeCleanupRef.current?.();

      if (pendingResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingResizeFrameRef.current);
        pendingResizeFrameRef.current = null;
      }
      activeResizeRef.current = null;

      const visibleCount = visibleChats.length;
      const containerWidth = containerRef.current?.clientWidth ?? 0;
      const equalWidth = Math.max(
        CHAT_PANEL_MIN_WIDTH_PX,
        containerWidth / visibleCount,
      );
      const nextWidths = {
        ...widthRef.current,
        ...Object.fromEntries(
          visibleChats.map((chat) => [chat.id, equalWidth]),
        ),
      };

      widthRef.current = nextWidths;

      for (const chat of visibleChats) {
        const column = columnRefs.current[chat.id];
        if (column) {
          column.style.flex = `1 1 ${equalWidth}px`;
        }
      }

      onChatColumnWidthsChange(nextWidths);
    },
    [onChatColumnWidthsChange, visibleChats],
  );

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    leftChatId: string,
    rightChatId: string,
  ) => {
    event.preventDefault();
    resizeCleanupRef.current?.();

    const leftColumn = columnRefs.current[leftChatId];
    const rightColumn = columnRefs.current[rightChatId];
    if (!leftColumn || !rightColumn) {
      return;
    }

    const startX = event.clientX;
    const leftStartWidth = leftColumn.getBoundingClientRect().width;
    const rightStartWidth = rightColumn.getBoundingClientRect().width;
    const pairWidth = leftStartWidth + rightStartWidth;
    const maxLeftWidth = Math.max(
      CHAT_PANEL_MIN_WIDTH_PX,
      pairWidth - CHAT_PANEL_MIN_WIDTH_PX,
    );
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const clearPendingFrame = () => {
      if (pendingResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingResizeFrameRef.current);
        pendingResizeFrameRef.current = null;
      }
    };

    const updateWidths = (clientX: number) => {
      const deltaX = clientX - startX;
      const leftWidth = Math.min(
        maxLeftWidth,
        Math.max(CHAT_PANEL_MIN_WIDTH_PX, leftStartWidth + deltaX),
      );
      const rightWidth = Math.max(
        CHAT_PANEL_MIN_WIDTH_PX,
        pairWidth - leftWidth,
      );
      const nextWidths = {
        ...widthRef.current,
        [leftChatId]: leftWidth,
        [rightChatId]: rightWidth,
      };

      widthRef.current = nextWidths;
      scheduleColumnWidthApply(leftChatId, leftWidth, rightChatId, rightWidth);
      return nextWidths;
    };

    let latestWidths = widthRef.current;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      latestWidths = updateWidths(moveEvent.clientX);
    };
    const handlePointerEnd = (upEvent: PointerEvent) => {
      latestWidths = updateWidths(upEvent.clientX);
      clearPendingFrame();

      const activeResize = activeResizeRef.current;
      if (activeResize) {
        applyColumnWidths(
          activeResize.leftChatId,
          activeResize.leftWidth,
          activeResize.rightChatId,
          activeResize.rightWidth,
        );
      }
      activeResizeRef.current = null;

      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerEnd);
      document.removeEventListener("pointercancel", handlePointerEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      resizeCleanupRef.current = null;
      onChatColumnWidthsChange(latestWidths);
    };

    resizeCleanupRef.current = () => {
      clearPendingFrame();
      activeResizeRef.current = null;
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerEnd);
      document.removeEventListener("pointercancel", handlePointerEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      resizeCleanupRef.current = null;
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerEnd, { once: true });
    document.addEventListener("pointercancel", handlePointerEnd, {
      once: true,
    });
  };

  const handleChatHeaderPointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      chatId: string,
      chatIndex: number,
    ) => {
      if (event.button !== 0 || visibleChats.length < 2) {
        return;
      }

      const target = event.target;
      if (target instanceof Element && target.closest("button")) {
        return;
      }

      const metrics = visibleChats
        .map((chat) => {
          const column = columnRefs.current[chat.id];
          const rect = column?.getBoundingClientRect();

          return rect
            ? {
                id: chat.id,
                left: rect.left,
                width: rect.width,
              }
            : null;
        })
        .filter((metric): metric is ChatColumnMetric => Boolean(metric));

      if (metrics.length !== visibleChats.length) {
        return;
      }

      event.preventDefault();
      dragCleanupRef.current?.();

      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";

      const nextDragChat: ChatDragState = {
        chatId,
        currentIndex: chatIndex,
        currentX: event.clientX,
        initialIndex: chatIndex,
        metrics,
        moved: false,
        pointerId: event.pointerId,
        startX: event.clientX,
      };

      dragChatRef.current = nextDragChat;
      setDragChat(nextDragChat);

      const updateDrag = (clientX: number) => {
        const currentDragChat = dragChatRef.current;
        if (
          !currentDragChat ||
          currentDragChat.chatId !== chatId ||
          currentDragChat.pointerId !== event.pointerId
        ) {
          return;
        }

        const dragOffset = clientX - currentDragChat.startX;
        const moved =
          currentDragChat.moved || Math.abs(dragOffset) >= CHAT_DRAG_THRESHOLD;
        const candidateDragChat = {
          ...currentDragChat,
          currentX: clientX,
          moved,
        };
        const currentIndex = moved
          ? resolveChatDragIndex(candidateDragChat)
          : currentDragChat.initialIndex;
        const updatedDragChat = {
          ...candidateDragChat,
          currentIndex,
        };

        if (
          currentDragChat.currentX === updatedDragChat.currentX &&
          currentDragChat.currentIndex === updatedDragChat.currentIndex &&
          currentDragChat.moved === updatedDragChat.moved
        ) {
          return;
        }

        dragChatRef.current = updatedDragChat;
        setDragChat(updatedDragChat);
      };

      const teardownDrag = () => {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerEnd);
        document.removeEventListener("pointercancel", handlePointerCancel);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        dragCleanupRef.current = null;
      };

      const finishDrag = (clientX: number, shouldCommit: boolean) => {
        updateDrag(clientX);
        const committedDragChat = dragChatRef.current;
        teardownDrag();

        if (
          !committedDragChat ||
          committedDragChat.chatId !== chatId ||
          committedDragChat.pointerId !== event.pointerId
        ) {
          return;
        }

        const shouldReorder =
          shouldCommit &&
          committedDragChat.moved &&
          committedDragChat.initialIndex !== committedDragChat.currentIndex;

        if (shouldReorder) {
          const settlingIds = getDragAffectedChatIds(committedDragChat);
          dragChatRef.current = null;
          flushSync(() => {
            setDragChat(null);
            setSettlingChatIds(settlingIds);
            onChatReorder(
              committedDragChat.initialIndex,
              committedDragChat.currentIndex,
            );
          });
          return;
        }

        dragChatRef.current = null;
        setDragChat(null);
      };

      function handlePointerMove(moveEvent: PointerEvent) {
        updateDrag(moveEvent.clientX);
      }

      function handlePointerEnd(upEvent: PointerEvent) {
        finishDrag(upEvent.clientX, true);
      }

      function handlePointerCancel(cancelEvent: PointerEvent) {
        finishDrag(cancelEvent.clientX, false);
      }

      dragCleanupRef.current = () => {
        teardownDrag();
        dragChatRef.current = null;
        setDragChat(null);
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerEnd, { once: true });
      document.addEventListener("pointercancel", handlePointerCancel, {
        once: true,
      });
    },
    [onChatReorder, visibleChats],
  );

  return (
    <div
      className="min-h-0 flex-1 overflow-x-auto"
      ref={containerRef}
      style={{ minHeight: CHAT_PANEL_MIN_HEIGHT_PX }}
    >
      <div className="flex h-full min-h-0 min-w-full">
        {visibleChats.map((chat, index) => {
          const width = getColumnWidth(chat.id);
          const nextChat = visibleChats[index + 1] ?? null;
          const chatOffset = dragChat
            ? resolveChatOffset(dragChat, chat.id, index)
            : 0;
          const isDragging = chat.id === dragChat?.chatId && dragChat.moved;
          const isRepositioning =
            Boolean(dragChat?.moved) && (isDragging || chatOffset !== 0);
          const columnStyle: CSSProperties = {
            backgroundColor: WORKSPACE_VIEWPORT_BACKGROUND,
            flex: `1 1 ${width}px`,
            minWidth: CHAT_PANEL_MIN_WIDTH_PX,
            transform: `translateX(${chatOffset}px)`,
            zIndex: isDragging ? 10 : 0,
          };

          return (
            <div
              className={`relative flex min-h-0 ${
                isRepositioning || settlingChatIds.includes(chat.id)
                  ? "transition-none"
                  : "transition-transform duration-150 ease-out"
              }`}
              key={chat.id}
              ref={(element) => {
                columnRefs.current[chat.id] = element;
              }}
              style={columnStyle}
            >
              <div className="flex h-full min-w-0 flex-1 flex-col">
                <ChatPanel
                  canCloseChat={visibleChats.length > 1}
                  isActive={active && chat.id === activeChatId}
                  isProjectActive={active}
                  onActivateChat={() => onActivateChat(chat.id)}
                  onCloseChat={() => onCloseChat(chat.id)}
                  onHeaderPointerDown={(event) =>
                    handleChatHeaderPointerDown(event, chat.id, index)
                  }
                  project={project}
                  chat={chat}
                />
              </div>

              {nextChat ? (
                <hr
                  aria-label="Resize chat columns"
                  aria-orientation="vertical"
                  className="relative h-full w-2 shrink-0 cursor-col-resize border-0 bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:transition-colors before:content-[''] hover:before:bg-surface-300 dark:hover:before:bg-surface-700"
                  onDoubleClick={handleResizeDoubleClick}
                  onPointerDown={(event) =>
                    handleResizePointerDown(event, chat.id, nextChat.id)
                  }
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {hiddenMountedChats.map((chat) => (
        <div aria-hidden inert className="hidden" key={chat.id}>
          <ChatPanel isActive={false} project={project} chat={chat} />
        </div>
      ))}
    </div>
  );
};

export const WorkspaceChatStack = memo(WorkspaceChatStackImpl);
WorkspaceChatStack.displayName = "WorkspaceChatStack";
