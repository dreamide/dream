import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { TaskRunStepId } from "@/types/ide";
import { TASK_STEP_LABEL_KEYS } from "./task-steps";

export interface TaskSendBackDialogProps {
  /** Output of the step sending the task back; always passed along. */
  findings: string | null;
  onClose: () => void;
  onSubmit: (note: string) => void;
  toStep: TaskRunStepId;
}

/** Mount only while open so the note starts empty each time. */
export const TaskSendBackDialog = ({
  findings,
  onClose,
  onSubmit,
  toStep,
}: TaskSendBackDialogProps) => {
  const t = useTranslations("tasks");
  const commonT = useTranslations("common");
  const [note, setNote] = useState("");
  const stepLabel = t(TASK_STEP_LABEL_KEYS[toStep]);

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(note.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {t("sendBackTitle", { step: stepLabel })}
            </DialogTitle>
            <DialogDescription>{t("sendBackDescription")}</DialogDescription>
          </DialogHeader>
          {findings ? (
            <div className="space-y-2">
              <Label>{t("sendBackFindings")}</Label>
              <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-surface-300 bg-surface-100/60 p-2 text-muted-foreground text-xs leading-5 dark:border-surface-700 dark:bg-surface-800/40">
                {findings}
              </pre>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="task-send-back-note">{t("sendBackNote")}</Label>
            <Textarea
              autoFocus
              id="task-send-back-note"
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("sendBackNotePlaceholder")}
              rows={4}
              value={note}
            />
          </div>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              {commonT("cancel")}
            </Button>
            <Button type="submit">
              {t("sendBackSubmit", { step: stepLabel })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
