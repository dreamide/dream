import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { useIdeStore } from "../ide-store";
import { HostFolderBrowser } from "./host-folder-browser";
import { useHostStateLabel } from "./ssh-hosts-settings-section";

/**
 * Opens a folder on an SSH host as a project: pick the host (connecting it
 * if needed; ssh's prompts appear in their own dialog) and the folder on
 * that machine, by browsing its folders or typing the path.
 */
export const OpenOnHostDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const t = useTranslations("sshHosts");
  const stateLabel = useHostStateLabel();
  const sshHosts = useIdeStore((state) => state.settings.sshHosts);
  const hosts = useIdeStore((state) => state.hosts);
  const openProjectOnHost = useIdeStore((state) => state.openProjectOnHost);
  const setSettingsOpen = useIdeStore((state) => state.setSettingsOpen);
  const setSettingsSection = useIdeStore((state) => state.setSettingsSection);

  const [hostId, setHostId] = useState("");
  const [path, setPath] = useState("");
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (open && !sshHosts.some((host) => host.id === hostId)) {
      setHostId(sshHosts[0]?.id ?? "");
    }
  }, [hostId, open, sshHosts]);

  const runtime = hostId ? hosts[hostId] : undefined;

  const handleOpen = async () => {
    if (!hostId || !path.trim()) return;
    setOpening(true);
    try {
      if (await openProjectOnHost(hostId, path)) {
        setPath("");
        onOpenChange(false);
      }
    } finally {
      setOpening(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("openTitle")}</DialogTitle>
        </DialogHeader>
        {sshHosts.length === 0 ? (
          <div className="grid gap-3 text-sm">
            <p className="text-muted-foreground">{t("addHostFirst")}</p>
            <Button
              onClick={() => {
                onOpenChange(false);
                setSettingsSection("sshHosts");
                setSettingsOpen(true);
              }}
              variant="outline"
            >
              {t("add")}
            </Button>
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void handleOpen();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="open-on-host-host">{t("host")}</Label>
              <NativeSelect
                className="w-full"
                id="open-on-host-host"
                onChange={(event) => {
                  setHostId(event.target.value);
                  setPath("");
                }}
                value={hostId}
              >
                {sshHosts.map((host) => (
                  <NativeSelectOption key={host.id} value={host.id}>
                    {host.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <span className="text-muted-foreground text-xs">
                {stateLabel(runtime?.state)}
                {runtime?.error ? ` — ${runtime.error}` : ""}
              </span>
            </div>
            {hostId ? (
              <HostFolderBrowser hostId={hostId} onPathChange={setPath} />
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="open-on-host-path">{t("folderPath")}</Label>
              <Input
                autoFocus
                id="open-on-host-path"
                onChange={(event) => setPath(event.target.value)}
                placeholder={t("folderPlaceholder")}
                value={path}
              />
            </div>
            <DialogFooter>
              <Button
                onClick={() => onOpenChange(false)}
                type="button"
                variant="ghost"
              >
                {t("cancel")}
              </Button>
              <Button disabled={opening || !path.trim()} type="submit">
                {opening ? stateLabel("connecting") : t("open")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};
