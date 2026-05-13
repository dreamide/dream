import type { DesktopApi } from "@/types/ide";

export const hasDesktopApi = (): boolean => {
  return typeof window !== "undefined" && Boolean(window.dream?.isElectron);
};

export const getDesktopApi = (): DesktopApi | null => {
  if (!hasDesktopApi()) {
    return null;
  }

  return window.dream ?? null;
};
