import { Laptop, Server } from "lucide-react";
import { useTranslations } from "next-intl";
import { getClientPlatform } from "@/lib/connections/platform";
import type { ConnectionStatus } from "@/lib/connections/supervisor";
import { useConnectionState } from "@/lib/connections/use-connection-state";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { cn } from "@/lib/utils";
import type { HostConnectionState, ProjectConfig } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { HOME_HOST_STATE } from "../store/host-reach";
import { useHostStateLabel } from "./ssh-hosts-settings-section";
import { useHostChoices } from "./use-host-choices";

const STATE_DOT: Record<HostConnectionState, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500",
  disconnected: "bg-muted-foreground/50",
  failed: "bg-destructive",
  idle: "bg-muted-foreground/50",
  reconnecting: "bg-amber-500",
};

const HOME_DOT: Record<ConnectionStatus, string> = {
  connecting: "bg-amber-500",
  incompatible: "bg-destructive",
  offline: "bg-muted-foreground/50",
  ready: "bg-emerald-500",
  reconnecting: "bg-amber-500",
  unauthorized: "bg-destructive",
};

/**
 * Where a project runs (its files, agents and terminals): this computer, or
 * the SSH host it lives on, with that host's connection state. In a browser
 * the home host is not "this computer": it is named, with its connection.
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
  const config = useHostChoices().find((host) => host.id === hostId);
  const runtime = useIdeStore((state) =>
    hostId ? state.hosts[hostId] : undefined,
  );
  const remoteT = useTranslations("remote");
  const platform = getClientPlatform();
  const home = useConnectionState(LOCAL_HOST_ID);

  const base = cn(
    "flex h-7 min-w-0 max-w-[280px] items-center gap-1.5 px-2 text-muted-foreground text-xs",
    className,
  );

  if (!hostId && platform.kind === "web") {
    return (
      <div
        className={base}
        title={remoteT("runsOnHost", { host: platform.homeLabel })}
      >
        <Server className="size-3.5 shrink-0" />
        <span className="truncate text-foreground">{platform.homeLabel}</span>
        <span
          aria-label={stateLabel(HOME_HOST_STATE[home.status])}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            HOME_DOT[home.status],
          )}
          role="img"
        />
      </div>
    );
  }

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
