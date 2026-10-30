/**
 * Settings > Sharing & access: one host's identity, version and remote
 * access, and the clients authorized on it. The host owns everything here;
 * this page is a client's view of the host it picks: this computer's, or
 * on the desktop any connected host.
 *
 * What the client may do follows from what the host says about it
 * (`/api/remote/session`): its own computer's operator may change remote
 * access; a paired client with `manage` may pair and revoke clients but not
 * switch access on or off; one without `manage` sees why it sees nothing.
 * The host's name, version and address come from POST /api/host/settings.
 * The options a host started with are documentation's, not shown here.
 */
import { Copy, Ellipsis, RotateCcw, Server } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  ApiError,
  apiClient,
  getApiErrorMessage,
  type HostSettingsReport,
} from "@/lib/api-client";
import { hostFetch } from "@/lib/connections/host-endpoint";
import { getClientPlatform } from "@/lib/connections/platform";
import { getDesktopApi } from "@/lib/electron";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import type { HomeHostSettings } from "@/types/ide";
import { listHostChoices } from "../../../../electron/shared/host-connections.js";
import { useIdeStore } from "../ide-store";
import { RemoteAccessSection } from "./remote-access-section";
import { SettingsControlRow, SettingsGroup } from "./settings-shared";

/** What the host says about this client (`/api/remote/session`). */
interface ClientSession {
  kind?: "local";
  id?: string;
  scopes?: string[];
}

interface HostView {
  report: HostSettingsReport | null;
  /** Why there is no report: too old a host, or no `manage` access. */
  missing: "unavailable" | "needsManage" | null;
  session: ClientSession | null;
  error: string | null;
}

/** -1, 0 or 1 as version `a` is older, the same as or newer than `b`. */
const compareVersions = (a: string, b: string) => {
  const parts = (value: string) =>
    value
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index])
      return left[index] < right[index] ? -1 : 1;
  }
  return 0;
};

const copyText = async (text: string) => {
  const desktop = getDesktopApi();
  if (desktop) return desktop.writeClipboardText(text);
  await navigator.clipboard.writeText(text);
  return true;
};

const loadHost = async (hostId: string): Promise<HostView> => {
  const session = await hostFetch(hostId, "/api/remote/session")
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  try {
    const report = await apiClient.hostSettings({}, { hostId });
    return { error: null, missing: null, report, session };
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 403 || error.status === 401)
    )
      return { error: null, missing: "needsManage", report: null, session };
    if (error instanceof ApiError && error.status === 404)
      return { error: null, missing: "unavailable", report: null, session };
    return {
      error: getApiErrorMessage(error, String(error)),
      missing: null,
      report: null,
      session,
    };
  }
};

export function SharingAccessSection({ appVersion }: { appVersion: string }) {
  const t = useTranslations("sharing");
  const platform = getClientPlatform();
  const connections = useIdeStore((state) => state.hostConnections);
  const sshHosts = useIdeStore((state) => state.settings.sshHosts);
  const hosts = useIdeStore((state) => state.hosts);
  const choices = [
    ...(platform.hasHomeHost
      ? [{ id: LOCAL_HOST_ID, label: platform.homeLabel }]
      : []),
    ...listHostChoices(connections, sshHosts).filter(
      (choice: { id: string }) => hosts[choice.id]?.state === "connected",
    ),
  ] as { id: string; label: string }[];
  const [picked, setPicked] = useState<string | null>(null);
  const hostId = choices.some((choice) => choice.id === picked)
    ? (picked as string)
    : (choices[0]?.id ?? null);

  const [view, setView] = useState<HostView | null>(null);
  const [home, setHome] = useState<HomeHostSettings | null>(null);
  const [restarting, setRestarting] = useState(false);

  const reload = useCallback(async (id: string) => {
    setView(null);
    const [next, homeSettings] = await Promise.all([
      loadHost(id),
      id === LOCAL_HOST_ID
        ? (getDesktopApi()?.getHomeHostSettings() ?? Promise.resolve(null))
        : Promise.resolve(null),
    ]);
    setView(next);
    setHome(homeSettings ?? null);
  }, []);

  useEffect(() => {
    if (hostId) void reload(hostId);
  }, [hostId, reload]);

  if (!hostId) {
    return <p className="text-muted-foreground text-sm">{t("noHosts")}</p>;
  }

  const report = view?.report ?? null;
  const host = report?.host ?? null;
  // Restart: only the host this desktop started, running in its own process.
  const canRestart =
    hostId === LOCAL_HOST_ID && home?.mode === "detached" && home.owned;
  const restart = async () => {
    const desktop = getDesktopApi();
    if (!desktop) return;
    setRestarting(true);
    try {
      await desktop.restartHomeHost();
      await reload(hostId);
    } catch (error) {
      toast.error(getApiErrorMessage(error, t("restartFailed")));
    } finally {
      setRestarting(false);
    }
  };
  const relation =
    host?.version && appVersion
      ? compareVersions(host.version, appVersion)
      : null;

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h3 className="font-medium text-base">{t("title")}</h3>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>

      {choices.length > 1 ? (
        <Select
          onValueChange={(value) => {
            if (typeof value === "string") setPicked(value);
          }}
          value={hostId}
        >
          <SelectTrigger aria-label={t("hostLabel")} className="w-72">
            <SelectValue>
              {choices.find((choice) => choice.id === hostId)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            {choices.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {view === null ? (
        <div className="flex justify-center py-6">
          <Spinner className="size-4" />
        </div>
      ) : (
        <div className="space-y-8">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h4 className="flex min-w-0 items-center gap-2 font-medium text-sm">
                <Server className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {host?.name ??
                    choices.find((choice) => choice.id === hostId)?.label}
                </span>
              </h4>
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t("hostActions")}
                  disabled={!host && !canRestart}
                  render={
                    <Button size="icon-sm" type="button" variant="ghost" />
                  }
                >
                  <Ellipsis className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-44">
                  {host ? (
                    <>
                      <DropdownMenuItem
                        onClick={() => void copyText(host.hostId)}
                      >
                        <Copy className="size-3.5" />
                        {t("copyHostId")}
                      </DropdownMenuItem>
                      {host.fingerprint ? (
                        <DropdownMenuItem
                          onClick={() => void copyText(host.fingerprint ?? "")}
                        >
                          <Copy className="size-3.5" />
                          {t("copyFingerprint")}
                        </DropdownMenuItem>
                      ) : null}
                    </>
                  ) : null}
                  {canRestart ? (
                    <DropdownMenuItem
                      disabled={restarting}
                      onClick={() => void restart()}
                    >
                      <RotateCcw className="size-3.5" />
                      {t("restartHost")}
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <SettingsGroup>
              {host ? (
                <SettingsControlRow
                  controlClassName="w-auto md:w-auto"
                  description={
                    <span className="select-text font-mono text-xs">
                      {[host.version ?? "?", host.local ?? host.remote]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  }
                  label={t("version")}
                >
                  {relation === null ? null : (
                    <Badge variant="outline">
                      {relation === 0
                        ? t("versionSame")
                        : relation < 0
                          ? t("versionOlder")
                          : t("versionNewer")}
                    </Badge>
                  )}
                </SettingsControlRow>
              ) : (
                <p className="px-4 py-3 text-muted-foreground text-sm">
                  {view.error ??
                    (view.missing === "needsManage"
                      ? t("needsManage")
                      : t("unavailable"))}
                </p>
              )}
              {restarting ? (
                <p className="flex items-center gap-2 px-4 py-3 text-muted-foreground text-sm">
                  <Spinner className="size-3" />
                  {t("restarting")}
                </p>
              ) : null}
            </SettingsGroup>
          </div>

          {view.missing === "needsManage" ? null : (
            <RemoteAccessSection
              canChange={view.session?.kind === "local"}
              currentSessionId={view.session?.id ?? null}
              hostId={hostId}
              key={hostId}
            />
          )}
        </div>
      )}
    </div>
  );
}
