import type { DreamDesktopApi } from "@/types/ide";

export const hasDesktopApi = (): boolean => {
  return typeof window !== "undefined" && Boolean(window.dream?.isElectron);
};

export const getDesktopApi = (): DreamDesktopApi | null => {
  if (!hasDesktopApi()) {
    return null;
  }

  return window.dream ?? null;
};
