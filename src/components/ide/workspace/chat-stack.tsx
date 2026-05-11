import type { PointerEvent as ReactPointerEvent } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ChatConfig, ProjectConfig } from "@/types/ide";
import { ChatPanel } from "../chat-panel";
import { CHAT_PANEL_MIN_HEIGHT_PX, CHAT_PANEL_MIN_WIDTH_PX } from "./constants";

export interface WorkspaceChatStackProps {
  active: boolean;
  activeChatId: string | null;
  chatColumnWidths: Record<string, number>;
  mountedChats: ChatConfig[];
  onActivateChat: (chatId: string) => void;
  onChatColumnWidthsChange: (widths: Record<string, number>) => void;
  onCloseChat: (chatId: string) => void;
  openChatIds: string[];
  project: ProjectConfig;
}

const WorkspaceChatStackImpl = ({
  active,
  activeChatId,
  chatColumnWidths,
  mountedChats,
  onActivateChat,
  onChatColumnWidthsChange,
  onCloseChat,
  openChatIds,
  project,
}: WorkspaceChatStackProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [localWidths, setLocalWidths] = useState(chatColumnWidths);
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
    setLocalWidths(chatColumnWidths);
  }, [chatColumnWidths]);

  const getFallbackWidth = () => {
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    const visibleCount = Math.max(visibleChats.length, 1);
    return Math.max(CHAT_PANEL_MIN_WIDTH_PX, containerWidth / visibleCount);
  };

  const getColumnWidth = (chatId: string) =>
    localWidths[chatId] ?? getFallbackWidth();

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    leftChatId: string,
    rightChatId: string,
  ) => {
    event.preventDefault();

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
        ...localWidths,
        [leftChatId]: leftWidth,
        [rightChatId]: rightWidth,
      };

      setLocalWidths(nextWidths);
      return nextWidths;
    };

    let latestWidths = localWidths;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      latestWidths = updateWidths(moveEvent.clientX);
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      latestWidths = updateWidths(upEvent.clientX);
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      onChatColumnWidthsChange(latestWidths);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp, { once: true });
  };

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

          return (
            <div
              className="flex min-h-0"
              key={chat.id}
              ref={(element) => {
                columnRefs.current[chat.id] = element;
              }}
              style={{
                flex: `1 1 ${width}px`,
                minWidth: CHAT_PANEL_MIN_WIDTH_PX,
              }}
            >
              <div className="flex h-full min-w-0 flex-1 flex-col">
                <ChatPanel
                  canCloseChat={visibleChats.length > 1}
                  isActive={active && chat.id === activeChatId}
                  isProjectActive={active}
                  onActivateChat={() => onActivateChat(chat.id)}
                  onCloseChat={() => onCloseChat(chat.id)}
                  project={project}
                  chat={chat}
                />
              </div>

              {nextChat ? (
                <hr
                  aria-label="Resize chat columns"
                  aria-orientation="vertical"
                  className="relative h-full w-2 shrink-0 cursor-col-resize border-0 bg-transparent before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:content-['']"
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
