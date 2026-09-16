import type { KanbanColumnId } from "@/types/ide";

export type KanbanColumnLabelKey =
  | "columnBacklog"
  | "columnReady"
  | "columnInProgress"
  | "columnReview"
  | "columnDone";

export interface KanbanColumnDescriptor {
  id: KanbanColumnId;
  /** Key inside the `kanban` i18n namespace. */
  labelKey: KanbanColumnLabelKey;
}

export const KANBAN_COLUMNS: readonly KanbanColumnDescriptor[] = [
  { id: "backlog", labelKey: "columnBacklog" },
  { id: "ready", labelKey: "columnReady" },
  { id: "inProgress", labelKey: "columnInProgress" },
  { id: "review", labelKey: "columnReview" },
  { id: "done", labelKey: "columnDone" },
];
