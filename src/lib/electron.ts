import type { DesktopApi } from "@/types/ide";

let developmentApi: DesktopApi | null = null;

/** Fixture pages replace the bridge locally, including a frozen native preload. */
export const setFixtureDesktopApi = (api: DesktopApi) => {
  if (!import.meta.env.DEV || window.location.pathname !== "/__dev/fixtures") {
    throw new Error(
      "A fixture bridge is only available on the development fixture page.",
    );
  }
  developmentApi = api;
};

export const hasDesktopApi = (): boolean => {
  return (
    typeof window !== "undefined" &&
    Boolean(developmentApi?.isElectron || window.dream?.isElectron)
  );
};

export const getDesktopApi = (): DesktopApi | null => {
  if (!hasDesktopApi()) {
    return null;
  }

  return developmentApi ?? window.dream ?? null;
};
