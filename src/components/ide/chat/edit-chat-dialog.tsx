import { useTranslations } from "next-intl";
import type { FormEventHandler } from "react";
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

export interface EditChatDialogProps {
  onClose: () => void;
  onEditValueChange: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  editValue: string;
  open: boolean;
}

export const EditChatDialog = ({
  editValue,
  onClose,
  onEditValueChange,
  onSubmit,
  open,
}: EditChatDialogProps) => {
  const chatT = useTranslations("chat");
  const commonT = useTranslations("common");

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-sm">
        <form className="space-y-4" onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {chatT("editChat")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="edit-chat-name">{commonT("name")}</Label>
            <Input
              autoFocus
              id="edit-chat-name"
              onChange={(event) => onEditValueChange(event.target.value)}
              placeholder={commonT("enterName")}
              value={editValue}
            />
          </div>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              {commonT("cancel")}
            </Button>
            <Button disabled={editValue.trim().length === 0} type="submit">
              {commonT("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
