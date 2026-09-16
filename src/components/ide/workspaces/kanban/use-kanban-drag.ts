import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { isKanbanColumnId } from "@/lib/ide-defaults";
import type { KanbanColumnId } from "@/types/ide";

const DRAG_THRESHOLD_PX = 4;

export interface KanbanDragTarget {
  column: KanbanColumnId;
  index: number;
}

export interface KanbanDragGhost {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface DragSession {
  active: boolean;
  cardId: string;
  height: number;
  offsetX: number;
  offsetY: number;
  pointerId: number;
  startX: number;
  startY: number;
  target: KanbanDragTarget | null;
  width: number;
}

/**
 * Resolves the drop target under the pointer: the column element found via
 * hit-testing and the insertion index among that column's *other* cards
 * (count of cards whose vertical midpoint is above the pointer). This matches
 * `moveKanbanCardInList`'s index semantics exactly, so no adjustment is
 * needed when dragging within the same column.
 */
const resolveDragTarget = (
  clientX: number,
  clientY: number,
  draggedCardId: string,
): KanbanDragTarget | null => {
  const columnElement = document
    .elementFromPoint(clientX, clientY)
    ?.closest<HTMLElement>("[data-kanban-column]");
  if (!columnElement) {
    return null;
  }

  const column = columnElement.dataset.kanbanColumn;
  if (!isKanbanColumnId(column)) {
    return null;
  }

  let index = 0;
  for (const cardElement of Array.from(
    columnElement.querySelectorAll<HTMLElement>("[data-kanban-card]"),
  )) {
    if (cardElement.dataset.kanbanCard === draggedCardId) {
      continue;
    }

    const rect = cardElement.getBoundingClientRect();
    if (rect.top + rect.height / 2 < clientY) {
      index += 1;
    }
  }

  return { column, index };
};

export const useKanbanDrag = ({
  onMove,
}: {
  onMove: (cardId: string, column: KanbanColumnId, index: number) => void;
}) => {
  const sessionRef = useRef<DragSession | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const [dragCardId, setDragCardId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<KanbanDragTarget | null>(null);
  const [ghost, setGhost] = useState<KanbanDragGhost | null>(null);

  const endSession = useCallback(
    (commit: boolean) => {
      const session = sessionRef.current;
      cleanupRef.current?.();
      cleanupRef.current = null;
      sessionRef.current = null;
      document.body.style.userSelect = "";

      if (!session) {
        return;
      }

      if (session.active) {
        suppressClickRef.current = session.cardId;
        if (commit && session.target) {
          onMove(session.cardId, session.target.column, session.target.index);
        }
      }

      setDragCardId(null);
      setDragTarget(null);
      setGhost(null);
    },
    [onMove],
  );

  const onCardPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, cardId: string) => {
      if (event.button !== 0 || sessionRef.current) {
        return;
      }

      if (
        event.target instanceof Element &&
        event.target.closest("[data-kanban-no-drag]")
      ) {
        return;
      }

      const rect = event.currentTarget.getBoundingClientRect();
      sessionRef.current = {
        active: false,
        cardId,
        height: rect.height,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        target: null,
        width: rect.width,
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || moveEvent.pointerId !== session.pointerId) {
          return;
        }

        if (!session.active) {
          const distance = Math.hypot(
            moveEvent.clientX - session.startX,
            moveEvent.clientY - session.startY,
          );
          if (distance < DRAG_THRESHOLD_PX) {
            return;
          }

          session.active = true;
          document.body.style.userSelect = "none";
          setDragCardId(session.cardId);
        }

        moveEvent.preventDefault();
        setGhost({
          height: session.height,
          width: session.width,
          x: moveEvent.clientX - session.offsetX,
          y: moveEvent.clientY - session.offsetY,
        });

        const target = resolveDragTarget(
          moveEvent.clientX,
          moveEvent.clientY,
          session.cardId,
        );
        if (
          target?.column !== session.target?.column ||
          target?.index !== session.target?.index
        ) {
          session.target = target;
          setDragTarget(target);
        }
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== sessionRef.current?.pointerId) {
          return;
        }

        endSession(true);
      };

      const handlePointerCancel = () => endSession(false);

      const handleKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key === "Escape" && sessionRef.current?.active) {
          keyEvent.preventDefault();
          endSession(false);
        }
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointercancel", handlePointerCancel);
      window.addEventListener("keydown", handleKeyDown);
      cleanupRef.current = () => {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
        document.removeEventListener("pointercancel", handlePointerCancel);
        window.removeEventListener("keydown", handleKeyDown);
      };
    },
    [endSession],
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      sessionRef.current = null;
      document.body.style.userSelect = "";
    },
    [],
  );

  /** Consumes the one-shot click suppression that follows a completed drag. */
  const shouldSuppressClick = useCallback((cardId: string) => {
    if (suppressClickRef.current === cardId) {
      suppressClickRef.current = null;
      return true;
    }

    return false;
  }, []);

  return {
    dragCardId,
    dragTarget,
    ghost,
    onCardPointerDown,
    shouldSuppressClick,
  };
};
