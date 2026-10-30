/**
 * Settings > Connections > This computer: how the desktop runs its home
 * host (electron/desktop-host-preference.js). The host runs in its own
 * process by default; it can be kept running after quitting, or not run
 * at all (remote hosts only, from the next launch). DREAM_HOST_MODE
 * overrides the preference, which the section then only reports.
 */
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { getDesktopApi } from "@/lib/electron";
import type { HomeHostPreference, HomeHostSettings } from "@/types/ide";
import { SettingsControlRow, SettingsGroup } from "./settings-shared";

const MODE_KEYS = {
  child: "modeChild",
  "in-process": "modeInProcess",
  remote: "modeRemote",
  service: "modeService",
} as const satisfies Record<HomeHostSettings["mode"], string>;

export function HomeHostSection() {
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

  const save = async (changes: Partial<HomeHostPreference>) => {
    const desktop = getDesktopApi();
    if (!desktop) return;
    setSaving(true);
    try {
      setSettings(await desktop.setHomeHostPreference(changes));
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

  const { explicit, mode, preference, reason, restartRequired } = settings;
  const status =
    reason === "fallback"
      ? t("modeFallback")
      : explicit
        ? t("modeExplicit", { mode: t(MODE_KEYS[mode]) })
        : t(MODE_KEYS[mode]);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="font-medium text-base">{t("title")}</h3>
        <p className="text-muted-foreground text-sm">{t("description")}</p>
      </div>

      <SettingsGroup>
        <SettingsControlRow
          controlClassName="w-auto md:w-auto"
          description={status}
          label={t("statusLabel")}
        >
          {restartRequired ? (
            <Button
              onClick={() => void getDesktopApi()?.relaunchApp()}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("restart")}
            </Button>
          ) : null}
        </SettingsControlRow>
        <SettingsControlRow
          controlClassName="w-auto md:w-auto"
          description={t("keepRunningHint")}
          label={t("keepRunning")}
        >
          <Switch
            checked={preference.keepRunning}
            disabled={saving || mode !== "child"}
            onCheckedChange={(keepRunning) => void save({ keepRunning })}
          />
        </SettingsControlRow>
        <SettingsControlRow
          controlClassName="w-auto md:w-auto"
          description={t("remoteOnlyHint")}
          label={t("remoteOnly")}
        >
          <Switch
            checked={preference.mode === "remote"}
            disabled={saving || explicit}
            onCheckedChange={(remoteOnly) =>
              void save({ mode: remoteOnly ? "remote" : "local" })
            }
          />
        </SettingsControlRow>
      </SettingsGroup>
    </div>
  );
}
