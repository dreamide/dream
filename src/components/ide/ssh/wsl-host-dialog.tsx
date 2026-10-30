/**
 * Add host > WSL distribution (Windows): pick one of the installed
 * distributions. The host is saved as an SSH host whose target is
 * `wsl:<distribution>` (electron/ssh/wsl.js), which stays internal.
 */
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** The target that names a WSL distribution. */
export const wslTarget = (distribution: string) => `wsl:${distribution}`;

/** The distribution a `wsl:` target names, or null. */
export const wslDistributionOf = (target: string) =>
  target.startsWith("wsl:") ? target.slice(4) : null;

export function WslHostDialog({
  distributions,
  onCancel,
  onSave,
}: {
  distributions: string[];
  onCancel: () => void;
  onSave: (distribution: string) => void;
}) {
  const t = useTranslations("connections");
  const [distribution, setDistribution] = useState(distributions[0] ?? "");
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      open
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base leading-6">
            {t("wslTitle")}
          </DialogTitle>
          <DialogDescription>{t("wslDescription")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="wsl-distribution">{t("wslDistribution")}</Label>
          <Select
            onValueChange={(value) => {
              if (typeof value === "string") setDistribution(value);
            }}
            value={distribution}
          >
            <SelectTrigger className="w-full" id="wsl-distribution">
              <SelectValue>{distribution}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start" alignItemWithTrigger={false}>
              {distributions.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button onClick={onCancel} type="button" variant="outline">
            {t("cancel")}
          </Button>
          <Button
            disabled={!distribution}
            onClick={() => onSave(distribution)}
            type="button"
          >
            {t("wslAdd")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
