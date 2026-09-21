import { useTranslations } from "next-intl";
import { useMemo } from "react";
import {
  SegmentedToggle,
  type SegmentedToggleOption,
} from "@/components/ui/segmented-toggle";
import type { AppView } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { APP_VIEW_DESCRIPTORS } from "../workspaces/registry";

/**
 * One-click switch between the app-level workspaces. Works with or without an
 * active project.
 */
export const WorkspaceSwitcher = () => {
  const t = useTranslations("workspace");
  const appView = useIdeStore((s) => s.appView);
  const setAppView = useIdeStore((s) => s.setAppView);
  const options = useMemo(
    (): SegmentedToggleOption<AppView>[] =>
      APP_VIEW_DESCRIPTORS.map(({ icon, id, labelKey }) => ({
        icon,
        label: t(labelKey),
        value: id,
      })),
    [t],
  );

  return (
    <SegmentedToggle
      aria-label={t("switchWorkspace")}
      className="[-webkit-app-region:no-drag]"
      onPointerDown={(event) => {
        // Keep the titlebar from treating the press as a window drag.
        event.stopPropagation();
      }}
      onValueChange={setAppView}
      options={options}
      value={appView}
    />
  );
};
