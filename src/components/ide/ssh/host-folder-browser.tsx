import { ArrowUp, Folder, Home, PlugZap } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  apiClient,
  getApiErrorMessage,
  type HostDirectoriesResponse,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useIdeStore } from "../ide-store";

/**
 * The folders of an SSH host, for picking a project folder there: starts at
 * the host's home, a click goes into a folder (and makes it the path to
 * open), Up goes back out. Lists through the host's own API, so the host
 * must be connected; until it is, offers to connect.
 */
export const HostFolderBrowser = ({
  hostId,
  onPathChange,
}: {
  hostId: string;
  /** A folder was picked: its path on the host. */
  onPathChange: (path: string) => void;
}) => {
  const t = useTranslations("sshHosts");
  const runtime = useIdeStore((state) => state.hosts[hostId]);
  const label = useIdeStore(
    (state) =>
      state.settings.sshHosts.find((host) => host.id === hostId)?.label ??
      hostId,
  );
  const connectHost = useIdeStore((state) => state.connectHost);
  const connected = runtime?.state === "connected";

  const [listing, setListing] = useState<HostDirectoriesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  // Only the newest request's answer is shown.
  const requestRef = useRef(0);

  const list = useCallback(
    async (path?: string) => {
      const request = ++requestRef.current;
      setLoading(true);
      setError(null);
      try {
        const next = await apiClient.hostDirectories({ path }, { hostId });
        if (request !== requestRef.current) return null;
        setListing(next);
        return next;
      } catch (failure) {
        if (request === requestRef.current) {
          setError(getApiErrorMessage(failure, t("foldersFailed")));
        }
        return null;
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [hostId, t],
  );

  // A new host (or the host back) starts over at its home.
  useEffect(() => {
    setListing(null);
    if (connected) void list();
  }, [connected, list]);

  const open = async (path: string) => {
    const next = await list(path);
    if (next) onPathChange(next.path);
  };

  if (!connected) {
    const busy =
      runtime?.state === "connecting" || runtime?.state === "reconnecting";
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-3 rounded-md border px-4 text-center text-muted-foreground text-sm">
        <span>{t("connectToBrowse", { host: label })}</span>
        <Button
          disabled={busy}
          onClick={() => void connectHost(hostId)}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy ? (
            <Spinner className="size-3.5" />
          ) : (
            <PlugZap className="size-3.5" />
          )}
          {t("connect")}
        </Button>
      </div>
    );
  }

  const directories = (listing?.directories ?? []).filter(
    (entry) => showHidden || !entry.hidden,
  );

  return (
    <div className="flex h-56 flex-col overflow-hidden rounded-md border">
      <div className="flex items-center gap-1 border-b px-1.5 py-1">
        <Button
          aria-label={t("upFolder")}
          disabled={!listing?.parent || loading}
          onClick={() => listing?.parent && void open(listing.parent)}
          size="icon-sm"
          title={t("upFolder")}
          type="button"
          variant="ghost"
        >
          <ArrowUp className="size-3.5" />
        </Button>
        <Button
          aria-label={t("homeFolder")}
          disabled={!listing || loading}
          onClick={() => listing && void open(listing.home)}
          size="icon-sm"
          title={t("homeFolder")}
          type="button"
          variant="ghost"
        >
          <Home className="size-3.5" />
        </Button>
        <span
          className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs"
          title={listing?.path}
        >
          {listing?.path ?? ""}
        </span>
        {loading ? <Spinner className="size-3.5 shrink-0" /> : null}
        <div className="flex shrink-0 items-center gap-1.5 pr-1">
          <Checkbox
            checked={showHidden}
            id={`host-folders-hidden-${hostId}`}
            onCheckedChange={(checked) => setShowHidden(checked === true)}
          />
          <Label
            className="font-normal text-muted-foreground text-xs"
            htmlFor={`host-folders-hidden-${hostId}`}
          >
            {t("showHidden")}
          </Label>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {error ? (
          <div className="px-3 py-2 text-destructive text-sm">{error}</div>
        ) : !listing ? (
          <div className="px-3 py-2 text-muted-foreground text-sm">
            {t("loadingFolders")}
          </div>
        ) : directories.length === 0 ? (
          <div className="px-3 py-2 text-muted-foreground text-sm">
            {t("noFolders")}
          </div>
        ) : (
          directories.map((entry) => (
            <button
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1 text-left text-sm hover:bg-accent",
                entry.hidden && "text-muted-foreground",
              )}
              disabled={loading}
              key={entry.path}
              onClick={() => void open(entry.path)}
              type="button"
            >
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{entry.name}</span>
            </button>
          ))
        )}
        {listing?.truncated ? (
          <div className="px-3 py-1 text-muted-foreground text-xs">
            {t("foldersTruncated", { count: listing.directories.length })}
          </div>
        ) : null}
      </div>
    </div>
  );
};
