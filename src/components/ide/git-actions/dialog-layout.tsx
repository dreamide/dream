import { Check } from "lucide-react";
import type { ReactNode } from "react";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

export type NextStepOption<Value extends string> = {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  value: Value;
};

export const NextStepSelector = <Value extends string>({
  idPrefix,
  onValueChange,
  options,
  value,
}: {
  idPrefix: string;
  onValueChange: (value: Value) => void;
  options: NextStepOption<Value>[];
  value: Value;
}) => (
  <RadioGroup
    className="gap-0 overflow-hidden rounded-lg border border-foreground/10 bg-muted/35"
    onValueChange={(nextValue) => onValueChange(nextValue as Value)}
    value={value}
  >
    {options.map((option, index) => {
      const checked = option.value === value;
      const optionId = `${idPrefix}-${option.value}`;
      return (
        <label
          className={cn(
            "flex h-12 items-center gap-3 px-3 text-sm transition-colors",
            index > 0 ? "border-t border-foreground/10" : "",
            option.disabled
              ? "cursor-not-allowed text-muted-foreground/45"
              : "cursor-pointer text-foreground hover:bg-muted/55",
          )}
          htmlFor={optionId}
          key={option.value}
        >
          <RadioGroupItem
            className="sr-only"
            disabled={option.disabled}
            id={optionId}
            value={option.value}
          />
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center [&_svg]:size-4",
              option.disabled
                ? "text-muted-foreground/45"
                : "text-muted-foreground",
            )}
          >
            {option.icon}
          </span>
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          <Check
            className={cn(
              "size-4 shrink-0 transition-opacity",
              checked ? "opacity-100" : "opacity-0",
            )}
          />
        </label>
      );
    })}
  </RadioGroup>
);

const DialogIcon = ({ children }: { children: ReactNode }) => (
  <div className="flex size-5 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-5">
    {children}
  </div>
);

export const GitDialogHeader = ({
  icon,
  subtitle,
  title,
}: {
  icon: ReactNode;
  subtitle?: ReactNode;
  title: string;
}) => (
  <DialogHeader className="gap-1 text-left">
    <div className="flex min-w-0 items-center gap-3">
      <DialogIcon>{icon}</DialogIcon>
      <div className="min-w-0">
        <DialogTitle className="text-base leading-6">{title}</DialogTitle>
        {subtitle ? (
          <div className="truncate text-muted-foreground text-sm">
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  </DialogHeader>
);

export const DialogMetricRow = ({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) => (
  <div className="flex min-h-8 items-center justify-between gap-4 text-sm">
    <div className="inline-flex items-center gap-2 font-medium text-muted-foreground">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span>{label}</span>
    </div>
    <div className="min-w-0 text-right font-mono text-foreground text-xs">
      {value}
    </div>
  </div>
);

export const ActionError = ({ error }: { error: string | null }) =>
  error ? (
    <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-sm">
      {error}
    </div>
  ) : null;
