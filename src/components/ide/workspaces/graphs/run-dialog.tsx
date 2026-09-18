import { Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { GraphInput } from "@/types/agent-graphs";

export interface RunDialogStart {
  inputs: Record<string, unknown>;
  task: string;
}

export interface RunDialogProps {
  graphName: string;
  inputs: GraphInput[];
  onOpenChange: (open: boolean) => void;
  onStart: (start: RunDialogStart) => void;
  open: boolean;
}

type InputValue = string | boolean;

const isMissing = (input: GraphInput, value: InputValue | undefined) =>
  input.required &&
  input.type !== "boolean" &&
  (value === undefined || String(value).trim() === "");

/**
 * Asks what this run should work on: a free-form task plus one field per
 * declared run input. Values reach every step through the run's initial
 * state, so node instructions stay generic and reusable.
 */
export const RunDialog = ({
  graphName,
  inputs,
  onOpenChange,
  onStart,
  open,
}: RunDialogProps) => {
  const t = useTranslations("graphs");
  const [task, setTask] = useState("");
  const [values, setValues] = useState<Record<string, InputValue>>({});
  const fields = inputs.filter((input) => input.key);
  const blocked = fields.some((input) => isMissing(input, values[input.key]));

  const setValue = (key: string, value: InputValue) =>
    setValues((current) => ({ ...current, [key]: value }));

  const start = () => {
    if (blocked) {
      return;
    }
    const resolved: Record<string, unknown> = {};
    for (const input of fields) {
      const value = values[input.key];
      if (input.type === "boolean") {
        resolved[input.key] = value === true;
      } else if (value !== undefined && String(value).trim() !== "") {
        resolved[input.key] = value;
      }
    }
    onStart({ inputs: resolved, task: task.trim() });
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("runDialogTitle", { name: graphName })}</DialogTitle>
          <DialogDescription>{t("runDialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          <Textarea
            autoFocus
            className="min-h-28 text-sm"
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

          {fields.map((input) => {
            const id = `run-input-${input.key}`;
            const label = input.label.trim() || input.key;
            const value = values[input.key];
            const options = input.options
              .map((option) => option.trim())
              .filter(Boolean);
            return (
              <div className="space-y-1.5" key={input.key}>
                {input.type === "boolean" ? (
                  <label
                    className="flex items-center gap-2 text-sm"
                    htmlFor={id}
                  >
                    <Checkbox
                      checked={value === true}
                      id={id}
                      onCheckedChange={(checked) =>
                        setValue(input.key, checked === true)
                      }
                    />
                    {label}
                  </label>
                ) : (
                  <>
                    <Label htmlFor={id}>
                      {label}
                      {input.required ? (
                        <span className="text-destructive"> *</span>
                      ) : null}
                    </Label>
                    {input.type === "enum" ? (
                      <Select
                        onValueChange={(next) =>
                          next !== null && setValue(input.key, String(next))
                        }
                        value={typeof value === "string" ? value : ""}
                      >
                        <SelectTrigger className="w-full min-w-0" id={id}>
                          <SelectValue>
                            {typeof value === "string" ? value : ""}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent
                          align="start"
                          alignItemWithTrigger={false}
                        >
                          {options.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={id}
                        onChange={(event) =>
                          setValue(input.key, event.target.value)
                        }
                        type={input.type === "number" ? "number" : "text"}
                        value={typeof value === "string" ? value : ""}
                      />
                    )}
                  </>
                )}
                {input.description ? (
                  <p className="text-xs text-muted-foreground">
                    {input.description}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            {t("cancelRun")}
          </Button>
          <Button
            disabled={blocked}
            onClick={start}
            type="button"
            variant="accent"
          >
            <Play className="size-3.5" />
            {t("run")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
