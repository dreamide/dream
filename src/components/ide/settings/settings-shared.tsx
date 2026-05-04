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
  children,
  error,
  installed,
  label,
  logoSrc,
  loading,
  runtimeLabel,
  version,
}: {
  children?: ReactNode;
  error: string | null;
  installed: boolean;
  label: string;
  logoSrc: string;
  loading: boolean;
  runtimeLabel: string;
  version: string | null;
}) => {
  const displayVersion = formatCliVersion(version);

  return (
    <div className="rounded-lg border border-foreground/10 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <img
              alt=""
              aria-hidden="true"
              className="size-4 shrink-0 dark:invert"
              src={logoSrc}
            />
            <p className="font-medium text-sm">{label}</p>
          </div>
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            {runtimeLabel}
            {displayVersion ? (
              <span className="rounded-full border border-foreground/10 bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-muted-foreground leading-none">
                {displayVersion}
              </span>
            ) : null}
          </p>
          {!loading && !installed ? (
            <p className="text-amber-700 text-sm">CLI not detected</p>
          ) : null}
        </div>
        {loading ? <Spinner className="mt-1 size-4" /> : null}
      </div>

      {error ? (
        <p className="mt-3 rounded-md bg-amber-500/8 px-3 py-2 text-amber-700 text-sm">
          {error}
        </p>
      ) : null}

      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
};

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
