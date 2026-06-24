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
      className="mr-1 h-7 gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-white hover:bg-primary-hover hover:text-white dark:bg-primary dark:text-white dark:hover:bg-primary-hover dark:hover:text-white [-webkit-app-region:no-drag]"
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
