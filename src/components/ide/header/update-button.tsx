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
      className="mr-1 h-8 bg-[var(--accent-primary)] px-2.5 text-[var(--accent-primary-foreground)] hover:bg-[var(--accent-primary-hover)] [-webkit-app-region:no-drag]"
      disabled={installing}
      onClick={installUpdate}
      size="sm"
      title={label}
      type="button"
    >
      <DownloadCloud className="size-3.5" />
      Update
    </Button>
  );
};
