import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { KanbanCard, KanbanColumnId } from "@/types/ide";
import { useIdeStore } from "../../ide-store";
import { KanbanCardPreview } from "./kanban-card";
import {
  KanbanCardDialog,
  type KanbanCardDialogValue,
} from "./kanban-card-dialog";
import { KanbanColumn } from "./kanban-column";
import { KANBAN_COLUMNS } from "./kanban-columns";
import { useKanbanDrag } from "./use-kanban-drag";

type KanbanDialogState =
  | { column: KanbanColumnId; mode: "create" }
  | { card: KanbanCard; mode: "edit" };

export interface KanbanBoardProps {
  cards: KanbanCard[];
  projectId: string;
}

export const KanbanBoard = ({ cards, projectId }: KanbanBoardProps) => {
  const t = useTranslations("kanban");
  const addKanbanCard = useIdeStore((s) => s.addKanbanCard);
  const updateKanbanCard = useIdeStore((s) => s.updateKanbanCard);
  const deleteKanbanCard = useIdeStore((s) => s.deleteKanbanCard);
  const moveKanbanCard = useIdeStore((s) => s.moveKanbanCard);
  const startKanbanCard = useIdeStore((s) => s.startKanbanCard);
  const openKanbanCardChat = useIdeStore((s) => s.openKanbanCardChat);
  const [dialog, setDialog] = useState<KanbanDialogState | null>(null);

  // Entering "In progress" (by drag or menu) starts the card's agent chat.
  const moveCard = useCallback(
    (cardId: string, column: KanbanColumnId, index: number) => {
      moveKanbanCard(projectId, cardId, column, index);
      if (column === "inProgress") {
        startKanbanCard(projectId, cardId);
      }
    },
    [moveKanbanCard, projectId, startKanbanCard],
  );

  const {
    dragCardId,
    dragTarget,
    ghost,
    onCardPointerDown,
    shouldSuppressClick,
  } = useKanbanDrag({ onMove: moveCard });

  const cardsByColumn = useMemo(() => {
    const groups: Record<KanbanColumnId, KanbanCard[]> = {
      backlog: [],
      done: [],
      inProgress: [],
      ready: [],
      review: [],
    };
    for (const card of cards) {
      groups[card.column].push(card);
    }
    return groups;
  }, [cards]);
  const draggedCard = dragCardId
    ? (cards.find((card) => card.id === dragCardId) ?? null)
    : null;

  const handleAddCard = useCallback(
    (column: KanbanColumnId) => setDialog({ column, mode: "create" }),
    [],
  );
  const handleEditCard = useCallback(
    (card: KanbanCard) => setDialog({ card, mode: "edit" }),
    [],
  );
  const handleDeleteCard = useCallback(
    (cardId: string) => deleteKanbanCard(projectId, cardId),
    [deleteKanbanCard, projectId],
  );
  const handleMoveCardToColumn = useCallback(
    (cardId: string, column: KanbanColumnId) =>
      moveCard(cardId, column, Number.POSITIVE_INFINITY),
    [moveCard],
  );
  const handleStartCard = useCallback(
    (cardId: string) => startKanbanCard(projectId, cardId),
    [projectId, startKanbanCard],
  );
  const handleOpenChat = useCallback(
    (cardId: string) => openKanbanCardChat(projectId, cardId),
    [openKanbanCardChat, projectId],
  );
  const closeDialog = useCallback(() => setDialog(null), []);
  const handleDialogSubmit = useCallback(
    (value: KanbanCardDialogValue) => {
      if (dialog?.mode === "create") {
        const cardId = addKanbanCard(projectId, {
          ...value,
          column: dialog.column,
        });
        if (cardId && dialog.column === "inProgress") {
          startKanbanCard(projectId, cardId);
        }
      } else if (dialog?.mode === "edit") {
        updateKanbanCard(projectId, dialog.card.id, (current) => ({
          ...current,
          ...value,
        }));
      }
      setDialog(null);
    },
    [addKanbanCard, dialog, projectId, startKanbanCard, updateKanbanCard],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2">
        <h2 className="font-semibold text-sm">{t("title")}</h2>
        <Badge variant="secondary">
          {t("cardCount", { count: cards.length })}
        </Badge>
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="mx-auto flex h-full w-max gap-2">
          {KANBAN_COLUMNS.map((column) => (
            <KanbanColumn
              cards={cardsByColumn[column.id]}
              column={column}
              dragCardId={dragCardId}
              dragTarget={dragTarget}
              ghostHeight={ghost?.height ?? null}
              key={column.id}
              onAddCard={handleAddCard}
              onCardPointerDown={onCardPointerDown}
              onDeleteCard={handleDeleteCard}
              onEditCard={handleEditCard}
              onMoveCard={handleMoveCardToColumn}
              onOpenChat={handleOpenChat}
              onStartCard={handleStartCard}
              shouldSuppressClick={shouldSuppressClick}
            />
          ))}
        </div>
      </div>
      {ghost && draggedCard ? (
        <div
          className="pointer-events-none fixed z-50"
          style={{ left: ghost.x, top: ghost.y, width: ghost.width }}
        >
          <KanbanCardPreview card={draggedCard} />
        </div>
      ) : null}
      {dialog ? (
        <KanbanCardDialog
          initialValue={
            dialog.mode === "edit"
              ? {
                  description: dialog.card.description,
                  title: dialog.card.title,
                }
              : null
          }
          key={dialog.mode === "edit" ? dialog.card.id : "create"}
          mode={dialog.mode}
          onClose={closeDialog}
          onSubmit={handleDialogSubmit}
        />
      ) : null}
    </div>
  );
};
