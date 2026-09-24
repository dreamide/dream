import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TASK_PROMPT_VARIABLES } from "@/lib/task-prompt";
import type { Task } from "@/types/ide";

export type TaskDialogValue = Pick<Task, "prompt" | "title">;

export interface TaskDialogProps {
  initialValue: TaskDialogValue | null;
  onClose: () => void;
  onSubmit: (value: TaskDialogValue) => void;
}

/**
 * Mount this only while open (keyed by the task being edited) so the form
 * state initialises from `initialValue` without effects.
 */
export const TaskDialog = ({
  initialValue,
  onClose,
  onSubmit,
}: TaskDialogProps) => {
  const t = useTranslations("tasks");
  const commonT = useTranslations("common");
  const [title, setTitle] = useState(initialValue?.title ?? "");
  const [prompt, setPrompt] = useState(initialValue?.prompt ?? "");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const canSubmit = title.trim().length > 0 && prompt.trim().length > 0;

  // Replaces the prompt's selection (or inserts at the caret) and leaves the
  // caret after the placeholder, so several can be added in a row.
  const insertVariable = (name: string) => {
    const token = `{{${name}}}`;
    const textarea = promptRef.current;
    const start = textarea?.selectionStart ?? prompt.length;
    const end = textarea?.selectionEnd ?? prompt.length;
    setPrompt(prompt.slice(0, start) + token + prompt.slice(end));
    const caret = start + token.length;
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(caret, caret);
    });
  };

  const submit = () => {
    if (canSubmit) {
      onSubmit({ prompt: prompt.trim(), title: title.trim() });
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="sm:max-w-2xl">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {initialValue ? t("editTask") : t("newTask")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="task-title">{t("titleLabel")}</Label>
            <Input
              autoFocus
              id="task-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("titlePlaceholder")}
              value={title}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-prompt">{t("promptLabel")}</Label>
            <Textarea
              className="max-h-[50vh] min-h-48"
              id="task-prompt"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={t("promptPlaceholder")}
              ref={promptRef}
              rows={10}
              value={prompt}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground text-xs">
                {t("promptVariables")}
              </span>
              {TASK_PROMPT_VARIABLES.map((name) => (
                <Badge
                  className="cursor-pointer font-mono hover:bg-muted"
                  key={name}
                  // Keep focus (and the caret) in the prompt while clicking.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertVariable(name)}
                  render={<button type="button" />}
                  title={t("insertVariable")}
                  variant="outline"
                >
                  {`{{${name}}}`}
                </Badge>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              {commonT("cancel")}
            </Button>
            <Button disabled={!canSubmit} type="submit">
              {initialValue ? commonT("save") : t("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
