import type { FormEvent } from "react";
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

export type ProjectRenameTarget = {
  id: string;
  name: string;
};

export const ProjectRenameDialog = ({
  onClose,
  onSubmit,
  onValueChange,
  target,
  value,
}: {
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onValueChange: (value: string) => void;
  target: ProjectRenameTarget | null;
  value: string;
}) => (
  <Dialog
    onOpenChange={(open) => {
      if (!open) {
        onClose();
      }
    }}
    open={target !== null}
  >
    <DialogContent className="sm:max-w-sm">
      <form className="space-y-4" onSubmit={onSubmit}>
        <DialogHeader>
          <DialogTitle>Rename project</DialogTitle>
          <DialogDescription>
            Choose a new name for this project.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          onChange={(event) => onValueChange(event.target.value)}
          placeholder="Enter a name"
          value={value}
        />
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button disabled={value.trim().length === 0} type="submit">
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
);
