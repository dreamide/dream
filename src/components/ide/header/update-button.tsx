import { AlertCircle, DownloadCloud } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import type { UpdateStatusEvent } from "@/types/ide";

const getUpdateLabel = (status: UpdateStatusEvent) => {
  if (status.state === "downloaded") {
    return status.updateVersion
      ? `Install Dream ${status.updateVersion}`
      : "Install update";
  }

  if (status.state === "downloading") {
    const percent = status.progress?.percent;
    return typeof percent === "number" && Number.isFinite(percent)
      ? `Downloading ${Math.floor(percent)}%`
      : "Downloading update";
  }

  if (status.state === "available") {
    return status.updateVersion
      ? `Downloading Dream ${status.updateVersion}`
      : "Downloading update";
  }

  return "Update error";
};

export const HeaderUpdateButton = () => {
  const [status, setStatus] = useState<UpdateStatusEvent | null>(null);
  const [installing, setInstalling] = useState(false);
  const [checking, setChecking] = useState(false);

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
      setChecking(false);
      if (nextStatus.state !== "downloaded") {
        setInstalling(false);
      }
    });

    return () => {
      mounted = false;
      removeUpdateStatus();
    };
  }, []);

  const visibleStates = status?.showDetailedStatus
    ? new Set(["available", "downloading", "downloaded", "error"])
    : new Set(["downloaded"]);

  if (!status || !visibleStates.has(status.state)) {
    return null;
  }

  const handleUpdateClick = async () => {
    const desktopApi = getDesktopApi();
    if (!desktopApi || installing || checking) {
      return;
    }

    if (status.state === "error") {
      setChecking(true);
      try {
        await desktopApi.checkForUpdates();
      } finally {
        setChecking(false);
      }
      return;
    }

    if (status.state !== "downloaded") {
      return;
    }

    setInstalling(true);
    const started = await desktopApi.installUpdate();
    if (!started) {
      setInstalling(false);
    }
  };

  const label = checking ? "Checking update" : getUpdateLabel(status);
  const disabled =
    installing ||
    checking ||
    status.state === "available" ||
    status.state === "downloading";
  const title =
    status.state === "error" && status.error
      ? `Update failed: ${status.error}. Click to retry.`
      : label;
  const Icon = status.state === "error" ? AlertCircle : DownloadCloud;

  return (
    <Button
      aria-label={label}
      className={cn(
        "mr-1 h-7 max-w-[180px] gap-1 rounded-md px-2 text-[11px] font-medium [-webkit-app-region:no-drag]",
        status.state === "error"
          ? "text-destructive hover:bg-destructive-surface-muted hover:text-destructive dark:hover:bg-destructive-surface"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        status.state === "downloaded" &&
          "bg-muted text-foreground hover:bg-muted/80 dark:bg-surface-800 dark:hover:bg-surface-700",
      )}
      disabled={disabled}
      onClick={handleUpdateClick}
      size="xs"
      title={title}
      type="button"
      variant="ghost"
    >
      <Icon className="size-3" />
      <span className="truncate">
        {status.state === "downloaded" ? "Update" : label}
      </span>
    </Button>
  );
};
