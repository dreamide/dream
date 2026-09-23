import { Shield, ShieldAlert, ShieldPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
} from "@/components/ui/select";
import type { ChatPermissionMode } from "@/types/ide";

const options = [
  { value: "ask", label: "askPermissions", icon: Shield },
  { value: "auto-accept-edits", label: "acceptEdits", icon: ShieldPlus },
  { value: "full-access", label: "fullAccess", icon: ShieldAlert },
] as const;

export function PermissionSelector({
  value,
  onChange,
}: {
  value: ChatPermissionMode;
  onChange: (value: ChatPermissionMode) => void;
}) {
  const t = useTranslations("chat");
  const selected =
    options.find((option) => option.value === value) ?? options[0];
  const Icon = selected.icon;

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const option = options.find((option) => option.value === next);
        if (option) onChange(option.value);
      }}
    >
      <SelectTrigger
        aria-label={`${t("permissions")}: ${t(selected.label)}`}
        className="h-7 w-auto shrink-0 gap-1 border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground data-[popup-open]:bg-transparent dark:bg-transparent dark:hover:bg-surface-900 dark:data-[popup-open]:bg-transparent"
        showChevron={false}
        title={t("permissions")}
      >
        <Icon className="size-3.5 shrink-0" />
        <span>{t(selected.label)}</span>
      </SelectTrigger>
      <SelectContent className="text-xs" side="top">
        <SelectGroup>
          <SelectLabel>{t("permissions")}</SelectLabel>
          {options.map(({ value, label, icon: OptionIcon }) => (
            <SelectItem className="text-xs" key={value} value={value}>
              <span className="flex items-center gap-1.5">
                <OptionIcon className="size-3.5 shrink-0" />
                <span>{t(label)}</span>
              </span>
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
