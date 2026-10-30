/**
 * Settings > Hosts > This app: whether this desktop runs agents on this
 * computer (electron/desktop-host-preference.js). Turning it off or on takes
 * effect at the next launch, which the section says and offers. While
 * DREAM_HOST_MODE decides, the toggle is read-only and says so.
 */
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { getDesktopApi } from "@/lib/electron";
import type { HomeHostSettings } from "@/types/ide";
import { SettingsControlRow, SettingsGroup } from "./settings-shared";

export function ThisAppSection() {
  const t = useTranslations("homeHost");
  const [settings, setSettings] = useState<HomeHostSettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getDesktopApi()
      ?.getHomeHostSettings()
      .then((next) => {
        if (!cancelled) setSettings(next);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLocal = async (local: boolean) => {
    const desktop = getDesktopApi();
    if (!desktop) return;
    setSaving(true);
    try {
      setSettings(
        await desktop.setHomeHostPreference({
          mode: local ? "local" : "remote",
        }),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="size-4" />
      </div>
    );
  }

  const { explicit, preference, reason, restartRequired } = settings;
  const notice = explicit
    ? t("setByEnv")
    : reason === "fallback"
      ? t("fallback")
      : reason === "shared-writer"
        ? t("sharedWriter")
        : restartRequired
          ? t("restartRequired")
          : null;

  return (
    <div className="space-y-4">
      <h3 className="font-medium text-base">{t("title")}</h3>
      <SettingsGroup>
        <SettingsControlRow
          controlClassName="w-auto md:w-auto"
          description={
            <>
              {t("localHostHint")}
              {notice ? <span className="mt-1 block">{notice}</span> : null}
            </>
          }
          label={t("localHost")}
        >
          <div className="flex items-center gap-3">
            {restartRequired && !explicit ? (
              <Button
                onClick={() => void getDesktopApi()?.relaunchApp()}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("restart")}
              </Button>
            ) : null}
            <Switch
              aria-label={t("localHost")}
              checked={preference.mode === "local"}
              disabled={saving || explicit || reason === "shared-writer"}
              onCheckedChange={(checked) => void setLocal(checked)}
            />
          </div>
        </SettingsControlRow>
      </SettingsGroup>
    </div>
  );
}
