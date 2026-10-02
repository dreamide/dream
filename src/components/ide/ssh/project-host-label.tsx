import { Laptop, Server } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { HostConnectionState, ProjectConfig } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { useHostStateLabel } from "./ssh-hosts-settings-section";

const STATE_DOT: Record<HostConnectionState, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500",
  disconnected: "bg-muted-foreground/50",
  failed: "bg-destructive",
  idle: "bg-muted-foreground/50",
  reconnecting: "bg-amber-500",
};

/**
 * Where a project runs (its files, agents and terminals): this computer, or
 * the SSH host it lives on, with that host's connection state.
 */
export const ProjectHostLabel = ({
  className,
  project,
}: {
  className?: string;
  project: Pick<ProjectConfig, "hostId">;
}) => {
  const t = useTranslations("sshHosts");
  const stateLabel = useHostStateLabel();
  const hostId = project.hostId;
  const config = useIdeStore((state) =>
    hostId
      ? state.settings.sshHosts.find((host) => host.id === hostId)
      : undefined,
  );
  const runtime = useIdeStore((state) =>
    hostId ? state.hosts[hostId] : undefined,
  );

  const base = cn(
    "flex h-7 min-w-0 max-w-[280px] items-center gap-1.5 px-2 text-muted-foreground text-xs",
    className,
  );

  if (!hostId) {
    return (
      <div className={base} title={t("runsHere")}>
        <Laptop className="size-3.5 shrink-0" />
        <span className="truncate">{t("localMachine")}</span>
      </div>
    );
  }

  const label = config?.label ?? hostId;
  // Connected counts once the host's catalog has loaded (until then the
  // project shows from its cached snapshot).
  const state: HostConnectionState =
    runtime?.state === "connected" && !runtime.loaded
      ? "connecting"
      : (runtime?.state ?? "idle");
  const title = [
    t("runsOn", { host: label, target: config?.target ?? hostId }),
    stateLabel(state),
    runtime?.error ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={base} title={title}>
      <Server className="size-3.5 shrink-0" />
      <span className="truncate text-foreground">{label}</span>
      <span
        aria-label={stateLabel(state)}
        className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[state])}
        role="img"
      />
    </div>
  );
};
