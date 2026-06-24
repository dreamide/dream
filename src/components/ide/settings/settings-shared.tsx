import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const formatCliVersion = (version: string | null) => {
  if (!version) {
    return null;
  }

  return version.match(/\d+(?:\.\d+)+(?:[-+][\w.-]+)?/)?.[0] ?? version;
};

export const formatDeletedDate = (value: string) => {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "";
  }

  return new Date(timestamp).toLocaleString();
};

export const ProviderStatusCard = ({
  action,
  children,
  error,
  icon,
  installed,
  label,
  logoSrc,
  loading,
  runtimeLabel,
  version,
}: {
  action?: ReactNode;
  children?: ReactNode;
  error: string | null;
  icon?: ReactNode;
  installed: boolean;
  label: string;
  logoSrc?: string;
  loading: boolean;
  runtimeLabel: string;
  version: string | null;
}) => {
  const displayVersion = formatCliVersion(version);
  const statusMessage =
    error || (!loading && !installed ? "CLI not detected." : null);

  return (
    <div className="rounded-lg border border-surface-200 dark:border-surface-800 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            {icon ??
              (logoSrc ? (
                <img
                  alt=""
                  aria-hidden="true"
                  className="size-4 shrink-0 dark:invert"
                  src={logoSrc}
                />
              ) : null)}
            <p className="font-medium text-sm">{label}</p>
          </div>
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            {runtimeLabel}
            {displayVersion ? (
              <span className="rounded-full border border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 px-2 py-0.5 font-mono text-[11px] text-muted-foreground leading-none">
                {displayVersion}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex size-6 items-center justify-center">
          {loading ? <Spinner className="size-3.5" /> : action}
        </div>
      </div>

      {statusMessage ? (
        <p className="mt-3 rounded-md border border-destructive-border bg-destructive-surface px-3 py-2 text-destructive text-sm dark:border-destructive-border-strong dark:bg-destructive-surface dark:text-destructive-muted">
          {statusMessage}
        </p>
      ) : null}

      {children && installed ? (
        <div className="mt-4 max-h-[min(34vh,22rem)] overflow-y-auto pr-1">
          {children}
        </div>
      ) : null}
    </div>
  );
};

export const SettingsGroup = ({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) => (
  <div>
    <div className="space-y-1 pt-2">
      <h3 className="text-muted-foreground text-xs uppercase">{label}</h3>
    </div>
    <div className="mt-2 border-l border-surface-200 pl-4 dark:border-surface-800">
      {children}
    </div>
  </div>
);

export const SettingsControlRow = ({
  children,
  controlClassName,
  description,
  label,
}: {
  children: ReactNode;
  controlClassName?: string;
  description: ReactNode;
  label: string;
}) => (
  <div className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between md:gap-8">
    <div className="min-w-0 space-y-0.5">
      <Label className="font-medium text-sm">{label}</Label>
      <div className="text-muted-foreground text-sm">{description}</div>
    </div>
    <div
      className={cn(
        "flex w-full justify-start md:w-96 md:shrink-0 md:justify-end",
        controlClassName,
      )}
    >
      {children}
    </div>
  </div>
);

export const SettingsSwitchRow = ({
  checked,
  description,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  description: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) => (
  <SettingsControlRow
    controlClassName="w-auto md:w-auto"
    description={description}
    label={label}
  >
    <Switch checked={checked} onCheckedChange={onCheckedChange} />
  </SettingsControlRow>
);
