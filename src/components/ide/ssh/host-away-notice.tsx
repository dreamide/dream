import { PlugZap, WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useConnectionState } from "@/lib/connections/use-connection-state";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { ProjectConfig } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { awayHost, type HostAway } from "./host-away";
import { useHostChoices } from "./use-host-choices";

/** `project`'s host while it is away (see isHostAway), or null. */
export const useHostAway = (
  project: Pick<ProjectConfig, "hostId"> | null | undefined,
): HostAway | null => {
  const hostId = project ? (project.hostId ?? LOCAL_HOST_ID) : null;
  const runtime = useIdeStore((state) =>
    hostId ? state.hosts[hostId] : undefined,
  );
  const stateHydrated = useIdeStore((state) => state.stateHydrated);
  const home = useConnectionState(LOCAL_HOST_ID);
  const label = useHostChoices().find((host) => host.id === hostId)?.label;
  if (!hostId) return null;
  return awayHost(
    { hosts: runtime ? { [hostId]: runtime } : {}, stateHydrated },
    hostId,
    () => label ?? hostId,
    home,
  );
};

/**
 * Above the composer while the project's host is away: connecting or
 * reconnecting (it comes back by itself), or not connected with a way to
 * connect again. Sending waits for the host.
 */
export const HostAwayNotice = ({ away }: { away: HostAway }) => {
  const t = useTranslations("sshHosts");
  const connectHost = useIdeStore((state) => state.connectHost);
  const pending = away.state === "connecting" || away.state === "reconnecting";
  // Connected with the catalog still loading reads as connecting.
  const loading = away.state === "connected";

  return (
    <div className="shrink-0 px-2 pb-1">
      <div
        className="mx-auto flex w-full max-w-[700px] items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-muted-foreground text-sm"
        role="status"
      >
        {pending || loading ? (
          <Spinner className="size-4 shrink-0" />
        ) : (
          <WifiOff className="size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1 break-words">
          {away.state === "reconnecting"
            ? t("reconnectingTo", { host: away.label })
            : pending || loading
              ? t("connectingTo", { host: away.label })
              : t("disconnectedFrom", { host: away.label })}
          {!pending && !loading && away.error ? ` ${away.error}` : null}
        </span>
        {/* The home host's connection comes back by itself. */}
        {pending || loading || away.hostId === LOCAL_HOST_ID ? null : (
          <Button
            className="shrink-0"
            onClick={() => void connectHost(away.hostId)}
            size="sm"
            variant="outline"
          >
            <PlugZap className="size-3.5" />
            {t("reconnect")}
          </Button>
        )}
      </div>
    </div>
  );
};
