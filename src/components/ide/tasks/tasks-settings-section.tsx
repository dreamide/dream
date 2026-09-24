import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Task } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { TaskDialog } from "./task-dialog";

type DialogState = { mode: "create" } | { mode: "edit"; task: Task } | null;

/**
 * Settings > Tasks: the app-wide list of saved prompts. Tasks are run from the
 * Tasks menu in a chat's composer, not from here.
 */
export const TasksSettingsSection = () => {
  const t = useTranslations("tasks");
  const commonT = useTranslations("common");
  const tasks = useIdeStore((state) => state.tasks);
  const addTask = useIdeStore((state) => state.addTask);
  const updateTask = useIdeStore((state) => state.updateTask);
  const deleteTask = useIdeStore((state) => state.deleteTask);
  const moveTask = useIdeStore((state) => state.moveTask);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Deleting asks for a second click on the same button.
  const handleDelete = (task: Task) => {
    if (pendingDeleteId !== task.id) {
      setPendingDeleteId(task.id);
      return;
    }
    deleteTask(task.id);
    setPendingDeleteId(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{t("title")}</h3>
          <p className="text-muted-foreground text-sm">{t("description")}</p>
        </div>
        <Button
          onClick={() => setDialog({ mode: "create" })}
          size="sm"
          type="button"
        >
          <Plus className="size-4" />
          {t("newTask")}
        </Button>
      </div>

      {tasks.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-md border border-dashed p-4 text-center">
          <p className="text-muted-foreground text-sm">{t("empty")}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border bg-white dark:bg-surface-950">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>{t("titleLabel")}</TableHead>
                <TableHead className="w-44" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task, index) => (
                <TableRow
                  data-task={task.id}
                  key={task.id}
                  onDoubleClick={() => setDialog({ mode: "edit", task })}
                >
                  <TableCell className="min-w-0 whitespace-normal">
                    <div className="truncate font-medium text-sm">
                      {task.title}
                    </div>
                    <div className="mt-0.5 line-clamp-2 whitespace-pre-line text-muted-foreground text-xs leading-5">
                      {task.prompt}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        aria-label={t("moveUp")}
                        disabled={index === 0}
                        onClick={() => moveTask(task.id, index - 1)}
                        size="icon-sm"
                        title={t("moveUp")}
                        type="button"
                        variant="ghost"
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        aria-label={t("moveDown")}
                        disabled={index === tasks.length - 1}
                        onClick={() => moveTask(task.id, index + 1)}
                        size="icon-sm"
                        title={t("moveDown")}
                        type="button"
                        variant="ghost"
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button
                        aria-label={commonT("edit")}
                        onClick={() => setDialog({ mode: "edit", task })}
                        size="icon-sm"
                        title={commonT("edit")}
                        type="button"
                        variant="ghost"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        aria-label={commonT("delete")}
                        onBlur={() =>
                          setPendingDeleteId((current) =>
                            current === task.id ? null : current,
                          )
                        }
                        onClick={() => handleDelete(task)}
                        size={pendingDeleteId === task.id ? "sm" : "icon-sm"}
                        type="button"
                        variant={
                          pendingDeleteId === task.id ? "destructive" : "ghost"
                        }
                      >
                        {pendingDeleteId === task.id ? (
                          t("deleteConfirm")
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {dialog ? (
        <TaskDialog
          initialValue={dialog.mode === "edit" ? dialog.task : null}
          key={dialog.mode === "edit" ? dialog.task.id : "create"}
          onClose={() => setDialog(null)}
          onSubmit={(value) => {
            if (dialog.mode === "edit") {
              updateTask(dialog.task.id, value);
            } else {
              addTask(value);
            }
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
};
