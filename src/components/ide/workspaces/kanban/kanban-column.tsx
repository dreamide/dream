import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, memo, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { KanbanCard, KanbanColumnId } from "@/types/ide";
import { KanbanCardItem } from "./kanban-card";
import { KanbanColumnIcon } from "./kanban-column-icon";
import type { KanbanColumnDescriptor } from "./kanban-columns";
import type { KanbanDragTarget } from "./use-kanban-drag";

export const KANBAN_COLUMN_SURFACE_CLASSES =
  "overflow-hidden rounded-lg bg-surface-100/60 text-foreground dark:bg-surface-800/30";

export interface KanbanColumnProps {
  cards: KanbanCard[];
  column: KanbanColumnDescriptor;
  dragCardId: string | null;
  dragTarget: KanbanDragTarget | null;
  ghostHeight: number | null;
  onAddCard: (column: KanbanColumnId) => void;
  onCardPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    cardId: string,
  ) => void;
  onDeleteCard: (cardId: string) => void;
  onEditCard: (card: KanbanCard) => void;
  onMoveCard: (cardId: string, column: KanbanColumnId) => void;
  onOpenChat: (cardId: string) => void;
  onStartCard: (cardId: string) => void;
  shouldSuppressClick: (cardId: string) => boolean;
}

const KanbanColumnImpl = ({
  cards,
  column,
  dragCardId,
  dragTarget,
  ghostHeight,
  onAddCard,
  onCardPointerDown,
  onDeleteCard,
  onEditCard,
  onMoveCard,
  onOpenChat,
  onStartCard,
  shouldSuppressClick,
}: KanbanColumnProps) => {
  const t = useTranslations("kanban");
  const isDropTarget = dragTarget?.column === column.id;
  // The dragged card leaves its column while in flight; a placeholder gap
  // marks where it will land.
  const visibleCards = dragCardId
    ? cards.filter((card) => card.id !== dragCardId)
    : cards;
  const placeholderIndex = isDropTarget
    ? Math.min(dragTarget.index, visibleCards.length)
    : -1;
  const placeholder =
    placeholderIndex >= 0 ? (
      <div
        aria-hidden
        className="shrink-0 rounded-md border border-accent/60 border-dashed bg-accent/10"
        style={{ height: ghostHeight ?? 56 }}
      />
    ) : null;

  return (
    <section
      aria-label={t(column.labelKey)}
      className={cn(
        KANBAN_COLUMN_SURFACE_CLASSES,
        "flex w-72 shrink-0 flex-col transition-colors",
        isDropTarget && "ring-1 ring-inset ring-accent/40 bg-accent/5",
      )}
      data-kanban-column={column.id}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 px-3">
        <KanbanColumnIcon column={column.id} />
        <h3 className="min-w-0 truncate font-medium text-sm">
          {t(column.labelKey)}
        </h3>
        <span className="text-muted-foreground text-sm tabular-nums">
          {cards.length}
        </span>
        <Button
          aria-label={t("addCard")}
          className="ml-auto size-6 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => onAddCard(column.id)}
          size="icon-xs"
          title={t("addCard")}
          type="button"
          variant="ghost"
        >
          <Plus className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {visibleCards.map((card, index) => (
          <Fragment key={card.id}>
            {index === placeholderIndex ? placeholder : null}
            <KanbanCardItem
              card={card}
              dragging={false}
              onDelete={onDeleteCard}
              onEdit={onEditCard}
              onMove={onMoveCard}
              onOpenChat={onOpenChat}
              onPointerDown={onCardPointerDown}
              onStart={onStartCard}
              shouldSuppressClick={shouldSuppressClick}
            />
          </Fragment>
        ))}
        {placeholderIndex === visibleCards.length ? placeholder : null}
        <Button
          className="shrink-0 justify-start text-muted-foreground/70 hover:text-foreground"
          onClick={() => onAddCard(column.id)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Plus className="size-4" />
          {t("addCard")}
        </Button>
      </div>
    </section>
  );
};

export const KanbanColumn = memo(KanbanColumnImpl);
KanbanColumn.displayName = "KanbanColumn";
