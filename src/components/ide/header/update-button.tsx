import { AlertCircle, DownloadCloud } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { getDesktopApi } from "@/lib/electron";
import type { UpdateStatusEvent } from "@/types/ide";
import { UPDATE_BUTTON_VARIANT_BY_STATE } from "./update-button-styles";

export const HeaderUpdateButton = () => {
  const updatesT = useTranslations("updates");
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

  const getUpdateLabel = () => {
    if (status.state === "downloaded") {
      return status.updateVersion
        ? updatesT("installVersion", { version: status.updateVersion })
        : updatesT("installUpdate");
    }

    if (status.state === "downloading") {
      const percent = status.progress?.percent;
      return typeof percent === "number" && Number.isFinite(percent)
        ? updatesT("downloadingPercent", { percent: Math.floor(percent) })
        : updatesT("downloadingUpdate");
    }

    if (status.state === "available") {
      return status.updateVersion
        ? updatesT("downloadingVersion", { version: status.updateVersion })
        : updatesT("downloadingUpdate");
    }

    return updatesT("updateError");
  };

  const label = checking ? updatesT("checkingUpdate") : getUpdateLabel();
  const disabled =
    installing ||
    checking ||
    status.state === "available" ||
    status.state === "downloading";
  const title =
    status.state === "error" && status.error
      ? updatesT("updateFailedRetry", { error: status.error })
      : label;
  const Icon = status.state === "error" ? AlertCircle : DownloadCloud;

  return (
    <Button
      aria-label={label}
      className="mr-1 h-7 max-w-[180px] gap-1 rounded-md px-2 text-[11px] font-medium [-webkit-app-region:no-drag]"
      disabled={disabled}
      onClick={handleUpdateClick}
      size="xs"
      title={title}
      type="button"
      variant={UPDATE_BUTTON_VARIANT_BY_STATE[status.state]}
    >
      <Icon className="size-3" />
      <span className="truncate">
        {status.state === "downloaded" ? updatesT("update") : label}
      </span>
    </Button>
  );
};
