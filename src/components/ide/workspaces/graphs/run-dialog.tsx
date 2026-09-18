import { Play } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";

export interface RunDialogProps {
  graphName: string;
  onOpenChange: (open: boolean) => void;
  onStart: (task: string) => void;
  open: boolean;
}

/**
 * Asks what this run should work on. The task reaches every step, so step
 * instructions stay generic and the workflow is reusable.
 */
export const RunDialog = ({
  graphName,
  onOpenChange,
  onStart,
  open,
}: RunDialogProps) => {
  const t = useTranslations("graphs");
  const [task, setTask] = useState("");

  const start = () => {
    onStart(task.trim());
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("runDialogTitle", { name: graphName })}</DialogTitle>
          <DialogDescription>{t("runDialogDescription")}</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          className="min-h-32 text-sm"
          onChange={(event) => setTask(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              start();
            }
          }}
          placeholder={t("runDialogPlaceholder")}
          value={task}
        />
        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("cancelRun")}
          </Button>
          <Button onClick={start} type="button" variant="default">
            <Play className="size-3.5" />
            {t("run")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
