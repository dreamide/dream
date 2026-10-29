import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { desktopErrorMessage, getDesktopApi } from "@/lib/electron";

export const SettingsVersionButton = ({ version }: { version: string }) => {
  const updatesT = useTranslations("updates");
  const [checking, setChecking] = useState(false);
  const label = updatesT(checking ? "checkingUpdate" : "checkForUpdates");

  const handleCheckForUpdates = async () => {
    const desktopApi = getDesktopApi();
    if (!desktopApi || checking) {
      return;
    }

    setChecking(true);
    try {
      const status = await desktopApi.checkForUpdates();
      switch (status.state) {
        case "not-available":
          toast.success(updatesT("upToDate"));
          break;
        case "downloaded":
          toast.success(updatesT("updateReady"));
          break;
        case "available":
        case "downloading":
          toast.info(updatesT("downloadingUpdate"));
          break;
        case "disabled":
          toast.info(updatesT("updatesDisabled"));
          break;
        case "error":
          toast.error(updatesT("updateError"), {
            description: status.error ?? undefined,
          });
          break;
      }
    } catch (error) {
      toast.error(updatesT("updateError"), {
        description: desktopErrorMessage(error),
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Button
      aria-busy={checking}
      aria-label={`${label} (v${version})`}
      className="h-auto gap-2 p-0 font-mono text-muted-foreground text-xs hover:bg-transparent hover:text-foreground"
      disabled={checking}
      onClick={handleCheckForUpdates}
      size="xs"
      title={label}
      type="button"
      variant="ghost"
    >
      v{version}
      {checking ? <Spinner className="size-3" /> : null}
    </Button>
  );
};
