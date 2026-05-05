import type { FormEventHandler } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

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
}: EditChatDialogProps) => (
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
          <DialogTitle>Edit</DialogTitle>
          <DialogDescription>Update the name for this chat.</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          onChange={(event) => onEditValueChange(event.target.value)}
          placeholder="Enter a name"
          value={editValue}
        />
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={editValue.trim().length === 0} type="submit">
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
);
