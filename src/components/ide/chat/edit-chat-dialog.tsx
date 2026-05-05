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
          <DialogTitle className="text-base leading-6">Edit chat</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="edit-chat-name">Name</Label>
          <Input
            autoFocus
            id="edit-chat-name"
            onChange={(event) => onEditValueChange(event.target.value)}
            placeholder="Enter a name"
            value={editValue}
          />
        </div>
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
