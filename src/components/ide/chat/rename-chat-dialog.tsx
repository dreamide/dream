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

export interface RenameChatDialogProps {
  onClose: () => void;
  onRenameValueChange: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  open: boolean;
  renameValue: string;
}

export const RenameChatDialog = ({
  onClose,
  onRenameValueChange,
  onSubmit,
  open,
  renameValue,
}: RenameChatDialogProps) => (
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
          <DialogTitle>Rename chat</DialogTitle>
          <DialogDescription>
            Choose a new name for this chat.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          onChange={(event) => onRenameValueChange(event.target.value)}
          placeholder="Enter a name"
          value={renameValue}
        />
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={renameValue.trim().length === 0} type="submit">
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
);
