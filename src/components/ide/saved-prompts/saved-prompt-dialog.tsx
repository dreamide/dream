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
import type { SavedPrompt } from "@/types/ide";

export type SavedPromptDialogValue = Pick<SavedPrompt, "name" | "prompt">;

export interface SavedPromptDialogProps {
  initialValue: SavedPromptDialogValue | null;
  onClose: () => void;
  onSubmit: (value: SavedPromptDialogValue) => void;
}

/**
 * Mount this only while open (keyed by the saved prompt being edited) so the form
 * state initialises from `initialValue` without effects.
 */
export const SavedPromptDialog = ({
  initialValue,
  onClose,
  onSubmit,
}: SavedPromptDialogProps) => {
  const t = useTranslations("savedPrompts");
  const commonT = useTranslations("common");
  const [name, setName] = useState(initialValue?.name ?? "");
  const [prompt, setPrompt] = useState(initialValue?.prompt ?? "");
  const canSubmit = name.trim().length > 0 && prompt.trim().length > 0;

  const submit = () => {
    if (canSubmit) {
      onSubmit({ prompt: prompt.trim(), name: name.trim() });
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
              {initialValue ? t("editPrompt") : t("newPrompt")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="saved-prompt-name">{t("nameLabel")}</Label>
            <Input
              autoFocus
              id="saved-prompt-name"
              onChange={(event) => setName(event.target.value)}
              placeholder={t("namePlaceholder")}
              value={name}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="saved-prompt-text">{t("promptLabel")}</Label>
            <Textarea
              className="max-h-[50vh] min-h-48"
              id="saved-prompt-text"
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={t("promptPlaceholder")}
              rows={10}
              value={prompt}
            />
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
