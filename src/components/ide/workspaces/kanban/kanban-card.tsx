import {
  ArrowRightLeft,
  Ellipsis,
  FilePenLine,
  MessageSquare,
  Play,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { memo, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusDot } from "@/components/ui/status-dot";
import { cn } from "@/lib/utils";
import type { KanbanCard, KanbanColumnId } from "@/types/ide";
import { useActivityStore } from "../../activity-store";
import { useIdeStore } from "../../ide-store";
import {
  getKanbanCardStatus,
  getKanbanStatusDotProps,
  KANBAN_STATUS_LABEL_KEYS,
} from "./kanban-card-status";
import { KANBAN_COLUMNS } from "./kanban-columns";

const CARD_SURFACE_CLASSES =
  "rounded-md border border-surface-300 bg-surface-50 p-2.5 text-left shadow-xs dark:border-surface-700 dark:bg-surface-800";

export interface KanbanCardItemProps {
  card: KanbanCard;
  dragging: boolean;
  onDelete: (cardId: string) => void;
  onEdit: (card: KanbanCard) => void;
  onMove: (cardId: string, column: KanbanColumnId) => void;
  onOpenChat: (cardId: string) => void;
  onPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    cardId: string,
  ) => void;
  onStart: (cardId: string) => void;
  shouldSuppressClick: (cardId: string) => boolean;
}

const KanbanCardItemImpl = ({
  card,
  dragging,
  onDelete,
  onEdit,
  onMove,
  onOpenChat,
  onPointerDown,
  onStart,
  shouldSuppressClick,
}: KanbanCardItemProps) => {
  const t = useTranslations("kanban");
  const chatId = card.chatId;
  const chatTitle = useIdeStore((s) =>
    chatId
      ? (s.chats.find((chat) => chat.id === chatId && chat.deletedAt === null)
          ?.title ?? null)
      : null,
  );
  const streaming = useIdeStore((s) =>
    Boolean(chatId && s.streamingChatIds[chatId]),
  );
  const awaitingAnswer = useIdeStore((s) =>
    Boolean(chatId && s.awaitingAnswerChatIds[chatId]),
  );
  const activityEntry = useActivityStore((s) =>
    chatId ? s.entries[chatId] : undefined,
  );
  const status = getKanbanCardStatus({
    activityEntry,
    awaitingAnswer,
    card,
    chatExists: chatTitle !== null,
    streaming,
  });
  const dot = getKanbanStatusDotProps(status);
  const canOpenChat = chatTitle !== null;

  return (
    <article
      className={cn(
        CARD_SURFACE_CLASSES,
        "group/card select-none",
        dragging ? "opacity-30" : "cursor-grab",
      )}
      data-kanban-card={card.id}
      onDoubleClick={() => {
        if (!shouldSuppressClick(card.id)) {
          onEdit(card);
        }
      }}
      onPointerDown={(event) => onPointerDown(event, card.id)}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium text-sm">{card.title}</h3>
          {card.description ? (
            <p className="mt-1 line-clamp-3 whitespace-pre-line text-muted-foreground text-xs">
              {card.description}
            </p>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t("cardActions")}
                className="size-6 shrink-0 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100 data-[state=open]:text-foreground data-[state=open]:opacity-100"
                data-kanban-no-drag=""
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                size="icon-xs"
                type="button"
                variant="ghost"
              />
            }
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {canOpenChat ? (
              <DropdownMenuItem onClick={() => onOpenChat(card.id)}>
                <MessageSquare className="size-4" />
                {t("openChat")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => onStart(card.id)}>
                <Play className="size-4" />
                {t("start")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onEdit(card)}>
              <FilePenLine className="size-4" />
              {t("edit")}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ArrowRightLeft className="size-4" />
                {t("moveTo")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {KANBAN_COLUMNS.filter(
                  (column) => column.id !== card.column,
                ).map((column) => (
                  <DropdownMenuItem
                    key={column.id}
                    onClick={() => onMove(card.id, column.id)}
                  >
                    {t(column.labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDelete(card.id)}
            >
              <Trash2 className="size-4" />
              {t("delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {card.chatId ? (
        <div className="mt-2 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <StatusDot
            className={dot.className}
            color={dot.color}
            pulse={dot.pulse}
          />
          <span className="shrink-0">
            {t(KANBAN_STATUS_LABEL_KEYS[status])}
          </span>
          {chatTitle ? <span className="truncate">· {chatTitle}</span> : null}
        </div>
      ) : null}
    </article>
  );
};

export const KanbanCardItem = memo(KanbanCardItemImpl);
KanbanCardItem.displayName = "KanbanCardItem";

/** Static, subscription-free rendering used for the drag ghost. */
export const KanbanCardPreview = ({ card }: { card: KanbanCard }) => (
  <div className={cn(CARD_SURFACE_CLASSES, "rotate-1 shadow-lg")}>
    <h3 className="truncate font-medium text-sm">{card.title}</h3>
    {card.description ? (
      <p className="mt-1 line-clamp-3 whitespace-pre-line text-muted-foreground text-xs">
        {card.description}
      </p>
    ) : null}
  </div>
);
