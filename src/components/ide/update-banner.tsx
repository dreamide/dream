import {
  AlertCircle,
  DownloadCloud,
  LoaderCircle,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { getDesktopApi } from "@/lib/electron";
import type { UpdateStatusEvent } from "@/types/ide";

const VISIBLE_STATES = new Set(["available", "downloading", "downloaded"]);

function getUpdateLabel(status: UpdateStatusEvent) {
  const version = status.updateVersion
    ? `Dream ${status.updateVersion}`
    : "A Dream update";

  if (status.state === "downloaded") {
    return `${version} is ready to install.`;
  }

  if (status.state === "downloading") {
    const percent = status.progress?.percent;
    if (typeof percent === "number" && Number.isFinite(percent)) {
      return `Downloading ${version} (${Math.round(percent)}%).`;
    }
    return `Downloading ${version}.`;
  }

  if (status.state === "available") {
    return `${version} is available.`;
  }

  if (status.state === "error" && status.error) {
    return status.error;
  }

  return "";
}

function getProgressPercent(status: UpdateStatusEvent) {
  const percent = status.progress?.percent;
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return 0;
  }

  return Math.max(0, Math.min(100, percent));
}

export function UpdateBanner() {
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
    });

    return () => {
      mounted = false;
      removeUpdateStatus();
    };
  }, []);

  const shouldShow = useMemo(() => {
    if (!status) {
      return false;
    }

    if (VISIBLE_STATES.has(status.state)) {
      return true;
    }

    return status.state === "error" && status.manual;
  }, [status]);

  if (!status || !shouldShow) {
    return null;
  }

  const progressPercent = getProgressPercent(status);
  const label = getUpdateLabel(status);
  const Icon =
    status.state === "error"
      ? AlertCircle
      : status.state === "downloaded"
        ? RefreshCw
        : status.state === "downloading"
          ? LoaderCircle
          : DownloadCloud;

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

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-3 border-b border-surface-200 bg-surface-100 px-3 py-2 text-sm text-surface-900 dark:border-surface-800 dark:bg-surface-950 dark:text-surface-100">
      <Icon
        className={
          status.state === "downloading" ? "size-4 animate-spin" : "size-4"
        }
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{label}</div>
        {status.state === "downloading" ? (
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-300 dark:bg-surface-800">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        ) : null}
      </div>
      {status.state === "downloaded" ? (
        <Button
          disabled={installing}
          onClick={installUpdate}
          size="xs"
          type="button"
        >
          <RefreshCw className="size-3" />
          Restart
        </Button>
      ) : null}
    </div>
  );
}
