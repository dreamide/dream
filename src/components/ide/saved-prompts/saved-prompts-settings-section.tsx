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
import type { SavedPrompt } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { SavedPromptDialog } from "./saved-prompt-dialog";

type DialogState =
  | { mode: "create" }
  | { mode: "edit"; savedPrompt: SavedPrompt }
  | null;

/**
 * Settings > Prompts: the app-wide list of saved prompts. They are run from the
 * Run prompt menu in a chat's composer, not from here.
 */
export const SavedPromptsSettingsSection = () => {
  const t = useTranslations("savedPrompts");
  const commonT = useTranslations("common");
  const savedPrompts = useIdeStore((state) => state.savedPrompts);
  const addSavedPrompt = useIdeStore((state) => state.addSavedPrompt);
  const updateSavedPrompt = useIdeStore((state) => state.updateSavedPrompt);
  const deleteSavedPrompt = useIdeStore((state) => state.deleteSavedPrompt);
  const moveSavedPrompt = useIdeStore((state) => state.moveSavedPrompt);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  // Deleting asks for a second click on the same button.
  const handleDelete = (savedPrompt: SavedPrompt) => {
    if (pendingDeleteId !== savedPrompt.id) {
      setPendingDeleteId(savedPrompt.id);
      return;
    }
    deleteSavedPrompt(savedPrompt.id);
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
          {t("newPrompt")}
        </Button>
      </div>

      {savedPrompts.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-md border border-dashed p-4 text-center">
          <p className="text-muted-foreground text-sm">{t("emptyShort")}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border bg-white dark:bg-surface-950">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead>{t("nameLabel")}</TableHead>
                <TableHead className="w-44" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {savedPrompts.map((savedPrompt, index) => (
                <TableRow
                  data-saved-prompt={savedPrompt.id}
                  key={savedPrompt.id}
                  onDoubleClick={() => setDialog({ mode: "edit", savedPrompt })}
                >
                  <TableCell className="min-w-0 whitespace-normal">
                    <div className="truncate font-medium text-sm">
                      {savedPrompt.name}
                    </div>
                    <div className="mt-0.5 line-clamp-2 whitespace-pre-line text-muted-foreground text-xs leading-5">
                      {savedPrompt.prompt}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        aria-label={t("moveUp")}
                        disabled={index === 0}
                        onClick={() =>
                          moveSavedPrompt(savedPrompt.id, index - 1)
                        }
                        size="icon-sm"
                        title={t("moveUp")}
                        type="button"
                        variant="ghost"
                      >
                        <ArrowUp className="size-4" />
                      </Button>
                      <Button
                        aria-label={t("moveDown")}
                        disabled={index === savedPrompts.length - 1}
                        onClick={() =>
                          moveSavedPrompt(savedPrompt.id, index + 1)
                        }
                        size="icon-sm"
                        title={t("moveDown")}
                        type="button"
                        variant="ghost"
                      >
                        <ArrowDown className="size-4" />
                      </Button>
                      <Button
                        aria-label={commonT("edit")}
                        onClick={() => setDialog({ mode: "edit", savedPrompt })}
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
                            current === savedPrompt.id ? null : current,
                          )
                        }
                        onClick={() => handleDelete(savedPrompt)}
                        size={
                          pendingDeleteId === savedPrompt.id ? "sm" : "icon-sm"
                        }
                        type="button"
                        variant={
                          pendingDeleteId === savedPrompt.id
                            ? "destructive"
                            : "ghost"
                        }
                      >
                        {pendingDeleteId === savedPrompt.id ? (
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
        <SavedPromptDialog
          initialValue={dialog.mode === "edit" ? dialog.savedPrompt : null}
          key={dialog.mode === "edit" ? dialog.savedPrompt.id : "create"}
          onClose={() => setDialog(null)}
          onSubmit={(value) => {
            if (dialog.mode === "edit") {
              updateSavedPrompt(dialog.savedPrompt.id, value);
            } else {
              addSavedPrompt(value);
            }
            setDialog(null);
          }}
        />
      ) : null}
    </div>
  );
};
