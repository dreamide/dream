import type { FormEvent } from "react";
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

export type ProjectEditTarget = {
  id: string;
  name: string;
};

export const ProjectEditDialog = ({
  onClose,
  onSubmit,
  onValueChange,
  target,
  value,
}: {
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onValueChange: (value: string) => void;
  target: ProjectEditTarget | null;
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
          <DialogTitle className="text-base leading-6">
            Edit project
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="edit-project-name">Name</Label>
          <Input
            autoFocus
            id="edit-project-name"
            onChange={(event) => onValueChange(event.target.value)}
            placeholder="Enter a name"
            value={value}
          />
        </div>
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
