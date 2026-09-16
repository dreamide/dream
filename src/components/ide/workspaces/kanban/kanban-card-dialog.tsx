import { useTranslations } from "next-intl";
import { useState } from "react";
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

export interface KanbanCardDialogValue {
  description: string;
  title: string;
}

export interface KanbanCardDialogProps {
  initialValue: KanbanCardDialogValue | null;
  mode: "create" | "edit";
  onClose: () => void;
  onSubmit: (value: KanbanCardDialogValue) => void;
}

/**
 * Mount this only while open (keyed by the card being edited) so the local
 * form state initialises from `initialValue` without effects.
 */
export const KanbanCardDialog = ({
  initialValue,
  mode,
  onClose,
  onSubmit,
}: KanbanCardDialogProps) => {
  const t = useTranslations("kanban");
  const commonT = useTranslations("common");
  const [title, setTitle] = useState(initialValue?.title ?? "");
  const [description, setDescription] = useState(
    initialValue?.description ?? "",
  );
  const canSubmit = title.trim().length > 0;

  const submit = () => {
    if (!canSubmit) {
      return;
    }

    onSubmit({ description: description.trim(), title: title.trim() });
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
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {mode === "create" ? t("newCard") : t("editCard")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="kanban-card-title">{t("titleLabel")}</Label>
            <Input
              autoFocus
              id="kanban-card-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("titlePlaceholder")}
              value={title}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="kanban-card-description">
              {t("descriptionLabel")}
            </Label>
            <Textarea
              id="kanban-card-description"
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={t("descriptionPlaceholder")}
              rows={5}
              value={description}
            />
          </div>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              {commonT("cancel")}
            </Button>
            <Button disabled={!canSubmit} type="submit">
              {mode === "create" ? t("create") : commonT("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
