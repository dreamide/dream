import { DownloadCloud } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { getDesktopApi } from "@/lib/electron";
import type { UpdateStatusEvent } from "@/types/ide";

export const HeaderUpdateButton = () => {
  const [status, setStatus] = useState<UpdateStatusEvent | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      return;
    }

    let mounted = true;
    void desktopApi.getUpdateStatus().then((nextStatus) => {
      if (mounted) {
        setStatus(nextStatus);
      }
    });

    const removeUpdateStatus = desktopApi.onUpdateStatus((nextStatus) => {
      setStatus(nextStatus);
      if (nextStatus.state !== "downloaded") {
        setInstalling(false);
      }
    });

    return () => {
      mounted = false;
      removeUpdateStatus();
    };
  }, []);

  if (status?.state !== "downloaded") {
    return null;
  }

  const installUpdate = async () => {
    const desktopApi = getDesktopApi();
    if (!desktopApi || installing) {
      return;
    }

    setInstalling(true);
    const started = await desktopApi.installUpdate();
    if (!started) {
      setInstalling(false);
    }
  };

  const label = status.updateVersion
    ? `Install Dream ${status.updateVersion}`
    : "Install update";

  return (
    <Button
      aria-label={label}
      className="mr-1 h-7 gap-1 rounded-md bg-[color-mix(in_oklab,var(--accent-primary)_78%,black)] px-2 text-[11px] font-medium text-accent-primary-foreground hover:bg-[color-mix(in_oklab,var(--accent-primary)_70%,black)] hover:text-accent-primary-foreground [-webkit-app-region:no-drag]"
      disabled={installing}
      onClick={installUpdate}
      size="xs"
      title={label}
      type="button"
      variant="ghost"
    >
      <DownloadCloud className="size-3" />
      Update
    </Button>
  );
};
